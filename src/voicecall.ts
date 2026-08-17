/**
 * 📞 One call factory for every voice surface.
 *
 * The CLI's 'call' rail and the web dashboard's phone call are the SAME
 * agent on the same realtime socket — same tools, same image interception,
 * same absorption of spoken turns into the typed agent's history. Only the
 * audio differs (host child processes vs a browser over WebSocket), and that
 * is a transport, not a call. This factory holds everything the two rails
 * share so they cannot drift apart.
 *
 * Absorption rule (learned on the first live tool call): only completed
 * exchanges with a real user side land in agent.messages. A continuation —
 * the model speaking again after a tool, with no new user turn — has no
 * question to pair with; writing one in would fake the history.
 */
import type { Bot } from 'mineflayer';
import type { Message } from '@strands-agents/sdk';
import { textMessage } from './history-doctor.js';
import { RealtimeCall, type RealtimeEvent } from './realtime/realtime.js';
import type { TransportFactories } from './realtime/transport.js';

/** The one slice of a Strands Agent this file touches. */
/**
 * Just the history, and typed as `Message[]` on purpose: this is the seam where a
 * plain object literal once entered the transcript and bricked every later turn
 * (`msg.clone is not a function` — the SDK clones the whole history per call).
 * `unknown[]` is what allowed it, so the type is the guard now. Anything pushed
 * here must be a real Message, and the compiler says so.
 */
export interface AgentLike { messages: Message[] }

/**
 * The tool executor both rails share. Voice can't look at images: catch
 * capture_view's ImageBlock before it becomes 200KB of base64 read into the
 * model's spoken context. Errors come back as prose — a thrown tool that
 * answers nothing leaves a call hanging in silence forever.
 */
export function makeExecuteTool(tools: unknown[], touch?: () => void) {
  return async (name: string, args: unknown): Promise<string> => {
    touch?.();
    const t = tools.find((x) => (x as { toolSpec?: { name?: string } }).toolSpec?.name === name);
    if (!t) return `error: no tool named ${name}`;
    try {
      const r = await (t as { invoke: (a: unknown) => Promise<unknown> }).invoke(args);
      if (r && typeof r === 'object' && (r as { type?: string }).type === 'imageBlock') {
        return 'Screenshot captured, but I cannot inspect images mid-call — ask me over text chat to describe what I see.';
      }
      return typeof r === 'string' ? r : JSON.stringify(r ?? {});
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
}

/**
 * Fold a completed spoken exchange into the typed agent's history.
 *
 * These MUST be real Message instances. The SDK clones the whole history on
 * every model call (`this.messages.map((msg) => msg.clone())`), so a plain object
 * literal in there is a landmine that detonates on the NEXT turn, not this one —
 * and on every turn after it, forever. The live soak paid the full price: two
 * `as never` casts here, one voice call, and then `msg.clone is not a function`
 * on every journey step, every thinker cycle and every web ask until the process
 * died. The bot's body kept walking around with no mind at all, and was finally
 * kicked for `disconnect.timeout`.
 *
 * `as never` is what let it compile: it silenced the one check that knew these
 * were the wrong shape.
 */
export function absorbTurn(agent: AgentLike, e: { user: string; assistant: string; continuation: boolean }): boolean {
  if (e.continuation) return false;
  // Both sides go through textMessage, which returns null for empty or
  // whitespace-only text. A pair is absorbed ONLY if both halves have words:
  //
  //  - no user words  → there is no question to record (a stray line).
  //  - no assistant words → the turn answered by CALLING A TOOL and said
  //    nothing. Recording it as `TextBlock('')` is what bricked the mind in
  //    issue #39: the provider then refuses the whole history with
  //    `messages: text content blocks must be non-empty`, retryable=false,
  //    on EVERY rail, until the window slides past the block. A tool-only
  //    voice turn is normal, so the right amount of history to write is none.
  const spoken = (e.user ?? '').trim();
  const user = spoken ? textMessage('user', `(voice) ${spoken}`) : null;
  const assistant = textMessage('assistant', e.assistant);
  if (!user || !assistant) return false;
  agent.messages.push(user, assistant);
  return true;
}

export interface VoiceCallDeps {
  apiKey: string;
  bot: Bot;
  agent: AgentLike;
  /** The Strands tools to mount — caller decides the roster. */
  tools: unknown[];
  /** Reset the thinker's idle clock — a human is on the line. */
  touch?: () => void;
  /** Surface hook: rendering, web mirroring. Absorption already happened. */
  onEvent?: (e: RealtimeEvent) => void;
  /** Browser audio (web rail). Omitted = host sox/ffmpeg (CLI rail). */
  transport?: TransportFactories;
}

export function createVoiceCall(deps: VoiceCallDeps): RealtimeCall {
  return new RealtimeCall({
    apiKey: deps.apiKey,
    tools: deps.tools,
    executeTool: makeExecuteTool(deps.tools, deps.touch),
    context:
      `You are ${deps.bot.username} in a Minecraft world at ${deps.bot.entity?.position}. ` +
      `Players online: ${Object.keys(deps.bot.players ?? {}).filter((n) => n !== deps.bot.username).join(', ') || 'none'}.`,
    onEvent: (e) => {
      if (e.type === 'user_transcript') deps.touch?.();
      if (e.type === 'turn') absorbTurn(deps.agent, e);
      deps.onEvent?.(e);
    },
    ...(deps.transport ?? {}),
  });
}

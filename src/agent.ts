import { Agent, type Model } from '@strands-agents/sdk';
import { createBedrockModel, resolveModelSpec } from './model.js';
import { census } from './memcheck.js';
import type { Bot } from 'mineflayer';
import { allTools } from './tools/index.js';
import { guardTools } from './tools/connection-guard.js';
import type { ForkFactory } from './session.js';

/**
 * The turn-economy doctrine, shared by the primary bot and hired workers:
 * the composite tools each finish a whole job in one model turn — an agent
 * that doesn't know this burns ten turns doing one turn's work.
 */
export const TURN_ECONOMY = `One call beats ten — several tools finish a whole job; reach for them before looping:
- find_blocks groups veins/trees into clusters (veinSize, exposed) and takes comma
  alternatives ('coal_ore,deepslate_coal_ore', all log species in one search).
  exposed=false means sealed underground: expect to tunnel.
- dig_vein fells an entire tree or mines a whole vein from ONE starting block and sweeps
  the drops. Never issue dig_block per log/ore — that's ten turns doing one job.
- craft_item chains intermediates by itself (logs → planks → sticks → pickaxe) and, when
  short, names exactly what to gather and how many. Gather, then re-call. 3x3 recipes need
  a crafting table within 4 blocks — walk to one first.
- attack_entity with until:'dead' fights the whole duel (chase, cooldown, shield, retreat).
- build_structure drafts AND builds basic shells (box/wall/floor/pillar) from dimensions —
  dryRun first for the material bill. Hand-author build_blueprint plans only for custom
  shapes; never place_block loops for either.
- remember_place/recall_places waypoints: save home, base, farms once — recall beats
  re-exploring.`;

const SYSTEM_PROMPT = `You are a Minecraft bot embodied in a live game world via mineflayer.
Your username in game is "{username}".

You have real tools: perception (look around, find blocks, inventory), movement
(pathfinding, turning, raw controls), digging, building, crafting, combat,
containers, sleeping, and chat.

Behavior rules:
- ACT, don't narrate. When asked to "turn right", call the turn tool — don't describe turning.
- Perceive before acting: check get_status / look_around / find_blocks when the request
  depends on the world state you haven't verified this turn.
- Chain tools to finish multi-step jobs (find tree → go to it → dig logs → collect drops).
- You can SEE: capture_view returns a real first-person screenshot. Use it when geometry,
  aesthetics, or "what does it look like" matters — aim with turn/look_at first.
- Report results concisely, in a playful in-game voice. Mention coordinates when useful.
- If something fails, read the error — it usually names close matches or what's missing —
  and retry sensibly before giving up.
- NEVER ask a player for their coordinates — players usually don't know them. Use
  find_player to locate them, go_to (entity=) or follow_entity to reach them. If they are beyond
  view distance, say so and ask them to walk toward you.
- "Come here" / "to me" always means the player who is talking to you.
- Never toss your tools or armor unless explicitly asked.

${TURN_ECONOMY}
- A long errand (strip-mine, big build, expedition) belongs in a journey, not a single
  turn: start_journey runs it step by step in the background and survives interruptions.`;

export interface AgentOptions {
  /** A ready Model (from model.ts createModel) — the primary passes its own to every worker so the crew shares one provider. */
  model?: Model;
  /** Bedrock model id override when no `model` is given (tests, one-shot scripts). */
  modelId?: string;
  systemPrompt?: string;
  /** Extra tools mounted alongside the Minecraft ones (journeys, etc.). */
  extraTools?: unknown[];
  /** Tool names to leave out — e.g. workers drop capture_view because the
   *  prismarine-viewer is a one-port singleton owned by the primary bot. */
  excludeTools?: string[];
  /**
   * The connection generation (LiveBody.epoch). Given one, every tool call is
   * bound to the socket it started on and fails loudly when that socket dies,
   * instead of awaiting a dead emitter forever (issue #20). Omit it — as tests
   * and one-shot scripts do — and tools behave exactly as before.
   */
  epoch?: () => number;
}

/** The env-driven Bedrock model, synchronously — for callers that did not go through createModel(). */
function defaultModel(modelId?: string): Model {
  return createBedrockModel(resolveModelSpec({ ...process.env, STRANDS_MODEL_PROVIDER: 'bedrock' }, { modelId }));
}

/** Wrap a mineflayer bot in a Strands agent that can drive it. */
export function createMinecraftAgent(bot: Bot, opts: AgentOptions = {}) {
  // No model handed in → the synchronous default (Bedrock from env), so tests
  // and one-shot scripts keep constructing agents without an await. main()
  // resolves STRANDS_MODEL_PROVIDER once through createModel() and passes it.
  const model = opts.model ?? defaultModel(opts.modelId);
  const systemPrompt = (opts.systemPrompt ?? SYSTEM_PROMPT).replace('{username}', bot.username);
  const name = (t: unknown) => (t as { toolSpec?: { name?: string } }).toolSpec?.name;
  const base = opts.excludeTools?.length
    ? allTools(bot).filter((t) => !opts.excludeTools!.includes(name(t) ?? ''))
    : allTools(bot);
  const mounted = [...base, ...((opts.extraTools ?? []) as ReturnType<typeof allTools>)];
  // One wrapper here covers all 50-odd tools — a per-tool fix would be 50 edits
  // and would miss the next tool someone adds.
  const tools = opts.epoch
    ? guardTools(mounted, {
      epoch: opts.epoch,
      detail: () => `The body was ${bot.username ?? 'the bot'} at the time of the drop.`,
    })
    : mounted;

  const agent = new Agent({ model, tools, systemPrompt, printer: false });

  /** Fork constructor for the Session: same model/prompt/tools (tool objects
   *  shared deliberately — callbacks close over the one bot, which is the
   *  point: every fork drives the same body). */
  const forkFactory: ForkFactory = (seed, conversationManager) => {
    const fork = new Agent({ model, tools, systemPrompt, messages: seed, printer: false, conversationManager });
    // Every fork carries a seeded history AND closes over this bot through its
    // tools: an uncollected fork retains a whole world (issue #44). WeakRef
    // only — the census must never be the thing that keeps one alive.
    census.watch('agents', fork);
    return fork;
  };

  return { agent, forkFactory };
}

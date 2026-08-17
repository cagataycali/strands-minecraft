/**
 * 🩺 What the provider actually complained about, and what our transcript
 * actually looked like when it did.
 *
 * `Bedrock is unable to process your request.` is one string worn by at least
 * three different failures — a malformed message list (a `toolUse` whose
 * `toolResult` was dropped or reordered), a throttle on a shared quota, and a
 * transient service error. During live play the bot hit it exactly once, in the
 * one window where a fork was folding back into the root history, and the log
 * could not tell which of the three it was (issue #14). Guessing is not
 * diagnosis, so this module makes the answer visible:
 *
 *  - `classifyProviderError` names the exception class and says whether a retry
 *    is worth anything. `ValidationException` accuses OUR history;
 *    `ThrottlingException` exonerates it.
 *  - `historyShape` renders the transcript as roles + tool-pair ids and NOTHING
 *    else — a split pair is visible at a glance, and no world state, chat text
 *    or credential can leak into a log line.
 *  - `auditHistory` turns the shape into a verdict, so an intermittent provider
 *    error becomes a local assertion (HISTORY_AUDIT=true).
 */

export type ErrorKind = 'validation' | 'history-empty-text' | 'throttling' | 'transient' | 'local' | 'unknown';

/**
 * The provider sentence for the defect in issue #39. It quotes OUR message
 * list, so it is never "the provider having a bad day": some rail wrote a text
 * block with no words in it, the block sits in the history, and every turn on
 * every rail is refused (retryable=false) until it is removed. Healable in
 * place — see healEmptyText.
 */
export const EMPTY_TEXT_BLOCK_ERROR = /text content blocks? must be non-?empty|content blocks? must not be empty/i;
// The one SDK dependency, used only by healHistory — everything above it stays
// pure data-shape analysis a test can feed with object literals.
import { Message, contentBlockFromData } from '@strands-agents/sdk';

export interface ProviderError {
  /** The exception class as the provider named it, e.g. 'ValidationException'. */
  name: string;
  kind: ErrorKind;
  /** Worth trying again? Only throttles and transient service errors are. */
  retryable: boolean;
  message: string;
  /** HTTP status when the SDK surfaced one. */
  status?: number;
}

/**
 * A JS runtime error raised in OUR process — TypeError, ReferenceError and the
 * sentences V8 uses for them. Never retryable, never the provider's fault, and
 * the only class whose fix is in this repo.
 */
function isLocalDefect(e: Record<string, unknown>, named: string | undefined, message: string): boolean {
  if (e.$metadata || typeof e.statusCode === 'number') return false; // it crossed the wire
  if (named === 'TypeError' || named === 'ReferenceError' || named === 'RangeError') return true;
  return /is not a function|is not iterable|Cannot read propert|undefined is not|is not defined/i.test(message);
}

/**
 * Bedrock (and the SDK layers over it) hide the class in several places: the
 * error's own `name`, `$metadata`/`$fault` on an AWS SDK error, a `code`, or
 * just the message text. Look in all of them before giving up.
 */
export function classifyProviderError(err: unknown): ProviderError {
  const e = (err ?? {}) as Record<string, unknown>;
  const message = typeof e.message === 'string' ? e.message : String(err);
  const cause = e.cause as Record<string, unknown> | undefined;
  const meta = (e.$metadata ?? cause?.$metadata) as { httpStatusCode?: number } | undefined;
  const named = [e.name, e.code, e.__type, cause?.name, cause?.code]
    .find((n): n is string => typeof n === 'string' && n.length > 0 && n !== 'Error');
  const status = typeof e.statusCode === 'number' ? e.statusCode : meta?.httpStatusCode;
  const hay = `${named ?? ''} ${message}`;

  const kind: ErrorKind =
    // OUR crash, not theirs. A TypeError never crossed a network: it was thrown
    // inside this process, and blaming the provider for it costs hours. The soak
    // spent a whole session printing "this was the provider, not our transcript"
    // under `msg.clone is not a function` — a plain object literal pushed into
    // the history by our own voice rail.
    isLocalDefect(e, named, message) ? 'local'
      // Named BEFORE the generic validation branch, because the generic branch
      // said nothing useful: the live soak filed 14 of these as kind=unknown and
      // then printed 'this was the provider, not our transcript' for an error
      // quoting our own messages. This one has an address (a block we wrote) and
      // a cure (healEmptyText + retry the same turn).
      : EMPTY_TEXT_BLOCK_ERROR.test(message) ? 'history-empty-text'
      : /Validation|malformed|invalid.*(message|conversation)|toolResult|tool_use/i.test(hay) ? 'validation'
        : /Throttl|TooManyRequests|rate ?limit|quota|429/i.test(hay) || status === 429 ? 'throttling'
          : /Stream ended without completing|ModelStreamError|incomplete (message|response)|stream (was )?(interrupted|closed|ended|reset)/i.test(hay) ? 'transient'
            : /ServiceUnavailable|InternalServer|Timeout|ECONN|EPIPE|socket hang up|503|500/i.test(hay) || status === 503 || status === 500 ? 'transient'
            // The generic Bedrock sentence itself: no class, no verdict. Say so
            // rather than inventing one — that ambiguity IS the bug report.
            : 'unknown';

  return {
    name: named ?? 'Error',
    kind,
    // 'history-empty-text' is deliberately NOT retryable here: a blind retry
    // sends the same poisoned history and is refused identically. It is
    // retryable only AFTER healEmptyText removed the block — the session's
    // named heal path, not the generic backoff.
    retryable: kind === 'throttling' || kind === 'transient',
    message,
    status,
  };
}

type Blockish = { type?: string; toolUseId?: string; name?: string };
type Msgish = { role: string; content?: readonly unknown[] };

const blocks = (m: Msgish): Blockish[] => (m.content ?? []) as Blockish[];
/** Short, stable stub of a tool id: enough to pair, too little to identify. */
const shortId = (id?: string) => (id ? id.slice(-6) : '?');

/**
 * The transcript as shape only: `u`/`a` per role, `[use:abc123 dig]` and
 * `[res:abc123 ok]` per tool block, `+t` when the message also carries text.
 * Ids are truncated and no argument, result or text content is included.
 */
export function historyShape(msgs: readonly Msgish[]): string {
  return msgs
    .map((m) => {
      const tags = blocks(m).flatMap((b) => {
        if (b.type === 'toolUseBlock') return [`use:${shortId(b.toolUseId)}${b.name ? ` ${b.name}` : ''}`];
        if (b.type === 'toolResultBlock') return [`res:${shortId(b.toolUseId)}`];
        return [];
      });
      // '+∅' is the whole point of this marker existing: the old '+t' printed
      // identically for real prose and for '' , so the one defect that bricks
      // every rail (issue #39) was invisible in the shape line we log on every
      // failure. A message with both prints '+t+∅'.
      const texts = blocks(m).filter((b) => b.type === 'textBlock');
      const text = `${texts.some((b) => !isEmptyTextBlock(b)) ? '+t' : ''}${texts.some(isEmptyTextBlock) ? '+∅' : ''}`;
      return `${m.role === 'assistant' ? 'a' : m.role === 'user' ? 'u' : m.role}${tags.length ? `[${tags.join(' ')}]` : ''}${text}`;
    })
    .join(' ');
}

export interface HistoryAudit {
  ok: boolean;
  /** Human-readable defects, most serious first. */
  problems: string[];
  /** Roles + tool-pair ids, content-free. */
  shape: string;
  counts: { messages: number; toolUses: number; toolResults: number };
}

/**
 * Everything a provider will reject about a message list, checked locally:
 *  - a `toolUse` with no matching `toolResult` (the classic fold/trim casualty)
 *  - a `toolResult` with no matching `toolUse` (a trim cut through a pair)
 *  - a result that arrives BEFORE its use (a fold landed out of order)
 *  - a text block with no words in it (the empty-text brick, issue #39)
 *  - a transcript that does not start with a user message
 *  - duplicated ids (the same exchange folded twice)
 */
export function auditHistory(
  msgs: readonly Msgish[],
  /** `requireInstances`: also demand real Message instances. Only a live history
   *  can promise that — a shape fixture is plain by design — so the session opts
   *  in and the failure reporter does not. */
  opts: { requireInstances?: boolean } = {},
): HistoryAudit {
  const problems: string[] = [];
  const useAt = new Map<string, number>();
  const resAt = new Map<string, number>();
  let toolUses = 0;
  let toolResults = 0;

  msgs.forEach((m, i) => {
    for (const b of blocks(m)) {
      if (b.type === 'toolUseBlock' && b.toolUseId) {
        toolUses++;
        if (useAt.has(b.toolUseId)) problems.push(`duplicate toolUse ${shortId(b.toolUseId)} (messages ${useAt.get(b.toolUseId)} and ${i})`);
        else useAt.set(b.toolUseId, i);
      } else if (b.type === 'toolResultBlock' && b.toolUseId) {
        toolResults++;
        if (resAt.has(b.toolUseId)) problems.push(`duplicate toolResult ${shortId(b.toolUseId)} (messages ${resAt.get(b.toolUseId)} and ${i})`);
        else resAt.set(b.toolUseId, i);
      }
    }
  });

  for (const [id, at] of useAt) {
    const r = resAt.get(id);
    if (r === undefined) problems.push(`toolUse ${shortId(id)} at message ${at} has NO toolResult (split pair)`);
    else if (r < at) problems.push(`toolResult ${shortId(id)} at message ${r} precedes its toolUse at ${at} (out-of-order fold)`);
  }
  for (const [id, at] of resAt) {
    if (!useAt.has(id)) problems.push(`orphan toolResult ${shortId(id)} at message ${at} (trim cut through a pair)`);
  }
  // Empty text blocks: the provider refuses the WHOLE history for one of these
  // (`messages: text content blocks must be non-empty`), on every rail, until
  // it is gone. Reported first-class and by index, because the failure it
  // causes names no location at all.
  const emptyText = msgs
    .map((m, i) => (blocks(m).some((b) => b.type === 'textBlock' && isEmptyTextBlock(b)) ? i : -1))
    .filter((i) => i >= 0);
  if (emptyText.length > 0) {
    problems.push(`message(s) ${emptyText.slice(0, 6).join(', ')} carry an EMPTY text block — the provider refuses the whole history with 'text content blocks must be non-empty' (issue #39)`);
  }
  if (msgs.length > 0 && msgs[0].role !== 'user') problems.push(`history starts with '${msgs[0].role}', providers require a user message first`);
  // The shape a provider never gets to reject: the SDK clones the whole history
  // on every model call, so a plain object literal in there throws
  // `msg.clone is not a function` on the NEXT turn and every turn after it.
  // Name the culprit by index while it is still one bad push (soak: the voice
  // rail's absorbTurn bricked the mind for an entire session).
  const unclonable = !opts.requireInstances ? [] : msgs
    .map((m, i) => (typeof (m as { clone?: unknown }).clone === 'function' ? -1 : i))
    .filter((i) => i >= 0);
  if (unclonable.length > 0) {
    problems.push(`message(s) ${unclonable.slice(0, 6).join(', ')} are not Message instances (plain objects) — the SDK's clone() will throw on the next turn`);
  }

  return {
    ok: problems.length === 0,
    problems,
    shape: historyShape(msgs),
    counts: { messages: msgs.length, toolUses, toolResults },
  };
}

/** One log-ready block: what failed, and what we sent when it did. */
export function diagnose(err: unknown, msgs: readonly Msgish[]): string {
  const p = classifyProviderError(err);
  const a = auditHistory(msgs);
  const verdict = p.kind === 'local'
    ? 'this is OUR defect, thrown inside this process — the provider never saw it'
    : p.kind === 'history-empty-text'
    // Never blame the provider for an error that QUOTES our message list. If the
    // audit found the block, its index is already in a.problems; if it did not,
    // the window has since slid past it — say that instead of inventing a cause.
    ? (a.ok
      ? 'the provider rejected OUR transcript for an empty text block that is no longer in the window — a rail wrote a wordless message (issue #39); healEmptyText clears it'
      : `OUR transcript carries an empty text block: ${a.problems.join('; ')}`)
    : a.ok
    ? p.kind === 'validation'
      ? 'history looks WELL-FORMED yet the provider called it invalid — suspect a request-level field, not the message list'
      : 'history is well-formed — this was the provider, not our transcript'
    : `history is MALFORMED: ${a.problems.join('; ')}`;
  return [
    `[session] ${p.name}${p.status ? ` (${p.status})` : ''} kind=${p.kind} retryable=${p.retryable}: ${p.message}`,
    `[session] ${a.counts.messages} messages, ${a.counts.toolUses} toolUse / ${a.counts.toolResults} toolResult — ${verdict}`,
    `[session] shape: ${a.shape}`,
  ].join('\n');
}

/**
 * 🩹 Rehydrate plain-object messages into real Message instances, IN PLACE.
 *
 * The audit can only name the landmine; this defuses it. One plain object
 * literal in agent.messages makes the SDK's per-call clone throw
 * `msg.clone is not a function` on every turn that follows — the in-game
 * symptom is a bot that answers everything with the same error until the
 * process is restarted, while its body keeps walking (the live soak lost a
 * whole session to it; the user saw it as 'ouch, msg.clone is not a
 * function' in chat). Rebuilding via contentBlockFromData is lossless for
 * every block kind the SDK serializes (text, toolUse, toolResult, image…),
 * so healing beats crashing: the turn that just failed is retried by the
 * session's watchdog, and the history it retries against is whole again.
 *
 * Returns the indices healed (empty = nothing to do). Any block that
 * contentBlockFromData refuses is left alone and reported by the next
 * audit — a half-heal that hides an unknown shape would be worse than the
 * crash it prevents.
 */
export function healHistory(msgs: unknown[]): number[] {
  const healed: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as { clone?: unknown; role?: string; content?: unknown[] };
    if (typeof m?.clone === 'function' || !m?.role) continue;
    try {
      const content = (m.content ?? []).map((b) =>
        typeof (b as { toJSON?: unknown })?.toJSON === 'function' ? b : contentBlockFromData(b as never),
      );
      msgs[i] = new Message({ role: m.role as 'user' | 'assistant', content: content as never });
      healed.push(i);
    } catch {
      // unknown block shape — leave the evidence in place for the audit
    }
  }
  return healed;
}

/**
 * The ONE way a rail may turn spoken/typed text into a history message.
 *
 * Returns null when the text is empty or whitespace-only — because a provider
 * counts that as an empty content block and refuses the ENTIRE history from
 * then on:
 *
 *   400 messages: text content blocks must be non-empty   (retryable=false)
 *
 * That refusal is not a failed turn, it is a bricked mind (issue #39): the
 * offending block sits early in the transcript and survives, so every later
 * rail — journey step, thinker cycle, web ask, reflex turn — dies against it
 * until the sliding window happens to cut past it. Live cost measured: 14
 * refusals in 4 minutes, 3 deaths, 42 briefings piled up, bot at 4.3/20 hp.
 *
 * Empty text is a NORMAL event, not an anomaly: a voice turn whose answer was
 * a tool call has no words in it. So the caller's job is to notice `null` and
 * push nothing — never to "fix it up" with a placeholder, which would teach
 * the model it said something it did not.
 */
export function textMessage(role: 'user' | 'assistant', text: string): Message | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  return new Message({ role, content: [contentBlockFromData({ text: t }) as never] as never });
}

/** True when this block would be refused as empty by the provider. */
export function isEmptyTextBlock(b: unknown): boolean {
  const t = (b as { text?: unknown })?.text;
  return typeof t === 'string' && t.trim().length === 0;
}

/**
 * 🩹 Remove empty text blocks from the history, IN PLACE (issue #39).
 *
 * The twin of healHistory, for the other defect that bricks the mind rather
 * than failing one turn. A single wordless text block makes the provider
 * refuse the ENTIRE message list — `messages: text content blocks must be
 * non-empty`, retryable=false — so the bot answers every rail with the same
 * 400 until the sliding window happens to cut past the block. Live: 14
 * refusals in 4 minutes, 3 deaths, 42 briefings queued, hp 4.3/20.
 *
 * Two repairs, in order of how little they change:
 *  - strip the empty block, keeping the message when it still has content
 *    (an assistant turn that both spoke and called a tool);
 *  - drop the message when stripping would leave it BLOCKLESS, because an
 *    empty content array is refused just as hard as an empty block.
 *
 * Nothing is ever substituted for the missing words: a placeholder would tell
 * the model it said something it never said, which is a worse lie than a gap.
 * Returns the indices touched (before removal) so the log can name the writer.
 */
export function healEmptyText(msgs: unknown[]): { stripped: number[]; removed: number[] } {
  const stripped: number[] = [];
  const removed: number[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; content?: unknown[] };
    const content = m?.content;
    if (!m?.role || !Array.isArray(content)) continue;
    // isEmptyTextBlock only answers true for a block that HAS a text field, so
    // toolUse/toolResult/image blocks pass through untouched.
    const keep = content.filter((b) => !isEmptyTextBlock(b));
    if (keep.length === content.length) continue;
    if (keep.length === 0) {
      msgs.splice(i, 1);
      removed.push(i);
      continue;
    }
    try {
      msgs[i] = new Message({ role: m.role as 'user' | 'assistant', content: keep as never });
      stripped.push(i);
    } catch {
      // Cannot rebuild it — drop the whole message rather than leave the brick.
      msgs.splice(i, 1);
      removed.push(i);
    }
  }
  return { stripped: stripped.reverse(), removed: removed.reverse() };
}

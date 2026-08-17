/**
 * The model factory — one place that turns three env vars into a Strands
 * `Model`, for the primary bot AND every hired worker (fleet.ts reuses the
 * same instance, so the whole crew burns one provider's quota, on purpose).
 *
 *   STRANDS_MODEL_PROVIDER   bedrock (default) | openai | anthropic
 *   STRANDS_MODEL_ID         provider-specific model id (each has a default)
 *   AWS_REGION               bedrock only (default us-west-2)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY   read by the provider SDKs themselves
 *
 * Bedrock ships with the SDK. OpenAI and Anthropic are *peer* packages of
 * `@strands-agents/sdk` — not installed by default, because a Docker image
 * that only ever talks to Bedrock should not carry two more HTTP clients.
 * Pick one and the factory tells you the exact `npm install` line if the
 * package is missing, instead of a module-resolution stack trace.
 *
 * `resolveModelSpec` is the pure half (env → spec) so it can be unit-tested
 * without a network or the optional packages; `createModel` is the half that
 * imports and constructs.
 */
import { BedrockModel, type Model } from '@strands-agents/sdk';

export const PROVIDERS = ['bedrock', 'openai', 'anthropic'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Default model ids per provider — overridden by STRANDS_MODEL_ID. */
export const DEFAULT_MODEL_ID: Record<Provider, string> = {
  bedrock: 'global.anthropic.claude-sonnet-5',
  openai: 'gpt-5.4',
  anthropic: 'claude-sonnet-4-6',
};

/** The optional peer each non-Bedrock provider needs, and the subpath that exports its Model class. */
const PEER: Record<Exclude<Provider, 'bedrock'>, { pkg: string; subpath: string; className: string }> = {
  openai: { pkg: 'openai', subpath: '@strands-agents/sdk/models/openai', className: 'OpenAIModel' },
  anthropic: { pkg: '@anthropic-ai/sdk', subpath: '@strands-agents/sdk/models/anthropic', className: 'AnthropicModel' },
};

export interface ModelSpec {
  provider: Provider;
  modelId: string;
  /** bedrock only */
  region?: string;
}

export type ModelEnv = Partial<Record<'STRANDS_MODEL_PROVIDER' | 'STRANDS_MODEL_ID' | 'AWS_REGION', string | undefined>>;

/** env → spec. Throws on an unknown provider, naming the valid ones. */
export function resolveModelSpec(env: ModelEnv = process.env, overrides: { modelId?: string } = {}): ModelSpec {
  // compose passes `${VAR:-}` through, so empty means unset here.
  const raw = (env.STRANDS_MODEL_PROVIDER || 'bedrock').trim().toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`STRANDS_MODEL_PROVIDER=${JSON.stringify(raw)} is not a provider this bot knows — use one of ${PROVIDERS.join(' | ')}`);
  }
  const provider = raw as Provider;
  const modelId = overrides.modelId || env.STRANDS_MODEL_ID || DEFAULT_MODEL_ID[provider];
  return provider === 'bedrock'
    ? { provider, modelId, region: env.AWS_REGION || 'us-west-2' }
    : { provider, modelId };
}

/** The one-line remedy when a provider's peer package is missing. */
export function installHint(provider: Exclude<Provider, 'bedrock'>): string {
  return `STRANDS_MODEL_PROVIDER=${provider} needs the \`${PEER[provider].pkg}\` package (a peer of @strands-agents/sdk, not installed by default): npm install ${PEER[provider].pkg}`;
}

/** Is `err` the loader telling us the peer package is absent? */
function isMissingPackage(err: unknown, pkg: string): boolean {
  const e = err as { code?: string; message?: string };
  return (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') && String(e?.message ?? '').includes(`'${pkg}'`);
}

/** Bedrock needs no import and no await — agent.ts uses this directly when no model is handed in. */
export function createBedrockModel(spec: ModelSpec): Model {
  return new BedrockModel({ modelId: spec.modelId, region: spec.region });
}

/** Construct the Model for a spec. Bedrock is synchronous-safe; the others import their subpath on demand. */
export async function createModel(spec: ModelSpec = resolveModelSpec()): Promise<Model> {
  if (spec.provider === 'bedrock') return createBedrockModel(spec);
  const peer = PEER[spec.provider];
  let mod: Record<string, unknown>;
  try {
    mod = (await import(peer.subpath)) as Record<string, unknown>;
  } catch (err) {
    if (isMissingPackage(err, peer.pkg)) throw new Error(installHint(spec.provider), { cause: err });
    throw err;
  }
  const Ctor = mod[peer.className] as (new (o: { modelId: string }) => Model) | undefined;
  if (typeof Ctor !== 'function') throw new Error(`${peer.subpath} does not export ${peer.className} — @strands-agents/sdk version mismatch?`);
  return new Ctor({ modelId: spec.modelId });
}

/** One boot line so the choice is visible in the log, never guessed (config doctrine: say your number). */
export function describeModel(spec: ModelSpec): string {
  return `🧠 model ${spec.provider} · ${spec.modelId}${spec.region ? ` · ${spec.region}` : ''}`;
}

/**
 * The model factory picks a provider from env — without a network, and without
 * the optional provider packages installed (they are peers, absent from the
 * lockfile on purpose: this test PINS that absence produces the npm install
 * line, not a loader stack trace).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockModel } from '@strands-agents/sdk';
import { createModel, createBedrockModel, describeModel, installHint, resolveModelSpec, DEFAULT_MODEL_ID, PROVIDERS } from '../src/model.js';

test('resolveModelSpec: no env → bedrock, the documented default id and region', () => {
  const spec = resolveModelSpec({});
  assert.deepEqual(spec, { provider: 'bedrock', modelId: DEFAULT_MODEL_ID.bedrock, region: 'us-west-2' });
  // docker-compose passes `${STRANDS_MODEL_ID:-}` through — empty strings are unset, not ids.
  assert.deepEqual(resolveModelSpec({ STRANDS_MODEL_PROVIDER: '', STRANDS_MODEL_ID: '', AWS_REGION: '' }), spec);
  assert.equal(spec.modelId, 'global.anthropic.claude-sonnet-5', 'the README / compose default must match the code');
});

test('resolveModelSpec: STRANDS_MODEL_ID + AWS_REGION override, provider is case/space-insensitive', () => {
  assert.deepEqual(
    resolveModelSpec({ STRANDS_MODEL_PROVIDER: ' Bedrock ', STRANDS_MODEL_ID: 'us.anthropic.claude-opus-5', AWS_REGION: 'eu-central-1' }),
    { provider: 'bedrock', modelId: 'us.anthropic.claude-opus-5', region: 'eu-central-1' },
  );
  // A caller's explicit modelId (AgentOptions.modelId) beats the env.
  assert.equal(resolveModelSpec({ STRANDS_MODEL_ID: 'from-env' }, { modelId: 'from-opts' }).modelId, 'from-opts');
});

test('resolveModelSpec: openai / anthropic carry their own default ids and no region', () => {
  assert.deepEqual(resolveModelSpec({ STRANDS_MODEL_PROVIDER: 'openai' }), { provider: 'openai', modelId: DEFAULT_MODEL_ID.openai });
  assert.deepEqual(resolveModelSpec({ STRANDS_MODEL_PROVIDER: 'anthropic', STRANDS_MODEL_ID: 'claude-opus-4-1' }), { provider: 'anthropic', modelId: 'claude-opus-4-1' });
});

test('resolveModelSpec: an unknown provider fails at boot and names the valid ones', () => {
  assert.throws(() => resolveModelSpec({ STRANDS_MODEL_PROVIDER: 'ollama' }), /STRANDS_MODEL_PROVIDER="ollama".*bedrock \| openai \| anthropic/);
  assert.deepEqual([...PROVIDERS], ['bedrock', 'openai', 'anthropic']);
});

test('createModel: bedrock builds a BedrockModel with no network and no await needed', async () => {
  const spec = resolveModelSpec({ STRANDS_MODEL_ID: 'global.anthropic.claude-sonnet-5' });
  const sync = createBedrockModel(spec);
  assert.ok(sync instanceof BedrockModel);
  assert.ok((await createModel(spec)) instanceof BedrockModel, 'the async path picks the same class');
  assert.equal(describeModel(spec), '🧠 model bedrock · global.anthropic.claude-sonnet-5 · us-west-2');
});

test('createModel: a provider whose peer package is absent fails with the install line, not a loader trace', async (t) => {
  // These peers are deliberately not in package.json; if someone adds one,
  // this case must move to "constructs the class" — the assertion below says so.
  for (const [provider, pkg] of [['openai', 'openai'], ['anthropic', '@anthropic-ai/sdk']] as const) {
    let installed = true;
    try { await import(pkg); } catch { installed = false; }
    if (installed) { t.diagnostic(`${pkg} is installed — the switch constructs the class instead`); continue; }
    await assert.rejects(
      createModel({ provider, modelId: 'x' }),
      (err: unknown) => {
        const e = err as Error & { cause?: unknown };
        assert.equal(e.message, installHint(provider));
        assert.match(e.message, new RegExp(`npm install ${pkg.replace('/', '\\/')}$`));
        assert.ok(e.cause, 'the loader error rides along as cause for the curious');
        return true;
      },
    );
  }
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmProvider } from '../src/drivers/types.js';
import { checkLlm, describe as describeLlm, LLM_PROVIDERS, parseLlmSpec, requiredEnv } from '../src/llm.js';

describe('parseLlmSpec', () => {
  it('splits on the first colon only', () => {
    assert.deepEqual(parseLlmSpec('ollama:qwen3:8b'), { provider: 'ollama', model: 'qwen3:8b' });
    assert.deepEqual(parseLlmSpec('openrouter:meta-llama/llama-3.3-70b-instruct:free'), {
      provider: 'openrouter',
      model: 'meta-llama/llama-3.3-70b-instruct:free',
    });
    assert.deepEqual(parseLlmSpec('vercel:openai/gpt-4o-mini'), { provider: 'vercel', model: 'openai/gpt-4o-mini' });
    assert.deepEqual(parseLlmSpec('openai-compatible:qwen2.5-7b-instruct'), {
      provider: 'openai-compatible',
      model: 'qwen2.5-7b-instruct',
    });
  });

  it('rejects a missing model', () => {
    assert.throws(() => parseLlmSpec('ollama'), /no model/);
    assert.throws(() => parseLlmSpec('ollama:'), /no model/);
    assert.throws(() => parseLlmSpec('ollama:   '), /no model/);
  });

  it('rejects unknown or empty providers', () => {
    assert.throws(() => parseLlmSpec('gpt-4o'), /unknown LLM provider "gpt-4o"/);
    assert.throws(() => parseLlmSpec('nope:x'), /unknown LLM provider "nope"/);
    assert.throws(() => parseLlmSpec(':qwen3:8b'), /unknown LLM provider ""/);
  });

  it('round-trips through describe', () => {
    for (const spec of ['ollama:qwen3:8b', 'groq:llama-3.3-70b-versatile', 'scripted:happy']) {
      assert.equal(describeLlm(parseLlmSpec(spec)), spec);
    }
  });
});

describe('requiredEnv', () => {
  it('maps each provider to its key env var(s)', () => {
    const expected: Record<LlmProvider, string[]> = {
      ollama: [],
      openrouter: ['OPENROUTER_API_KEY'],
      vercel: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'],
      groq: ['GROQ_API_KEY'],
      cerebras: ['CEREBRAS_API_KEY'],
      'openai-compatible': [],
      openai: ['OPENAI_API_KEY'],
      anthropic: ['ANTHROPIC_API_KEY'],
      google: ['GOOGLE_API_KEY'],
      'browser-use': ['BROWSER_USE_API_KEY'],
      scripted: [],
    };
    assert.deepEqual([...LLM_PROVIDERS].sort(), Object.keys(expected).sort());
    for (const provider of LLM_PROVIDERS) {
      assert.deepEqual(requiredEnv({ provider, model: 'm' }), expected[provider], provider);
    }
  });

  it('apiKeyEnv overrides the default', () => {
    assert.deepEqual(requiredEnv({ provider: 'openai-compatible', model: 'm', apiKeyEnv: 'TOGETHER_API_KEY' }), [
      'TOGETHER_API_KEY',
    ]);
    assert.deepEqual(requiredEnv({ provider: 'openai', model: 'm', apiKeyEnv: 'MY_KEY' }), ['MY_KEY']);
  });
});

describe('checkLlm', () => {
  it('passes free/local providers without any key', () => {
    assert.equal(checkLlm({ provider: 'ollama', model: 'qwen3:8b' }, {}), null);
    assert.equal(checkLlm({ provider: 'scripted', model: 'happy' }, {}), null);
    assert.equal(checkLlm({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://localhost:1234/v1' }, {}), null);
  });

  it('openai-compatible needs a base URL', () => {
    assert.match(checkLlm({ provider: 'openai-compatible', model: 'm' }, {}) ?? '', /--llm-base-url/);
  });

  it('names the missing key, and accepts any of the alternatives', () => {
    assert.match(checkLlm({ provider: 'openrouter', model: 'x:free' }, {}) ?? '', /OPENROUTER_API_KEY/);
    assert.equal(checkLlm({ provider: 'openrouter', model: 'x:free' }, { OPENROUTER_API_KEY: 'k' }), null);
    assert.match(checkLlm({ provider: 'vercel', model: 'x' }, {}) ?? '', /AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN/);
    assert.equal(checkLlm({ provider: 'vercel', model: 'x' }, { VERCEL_OIDC_TOKEN: 't' }), null);
    assert.match(
      checkLlm({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://x/v1', apiKeyEnv: 'K' }, {}) ?? '',
      /needs K/,
    );
    assert.match(checkLlm({ provider: 'groq', model: 'x' }, { GROQ_API_KEY: '' }) ?? '', /GROQ_API_KEY/); // empty = unset
  });
});

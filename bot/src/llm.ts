// The LLM behind the browser-use driver's agent (used only to operate a post's menu; classification
// is always TypeSafe Jev). The model itself is built in Python (bot/browser-use/llm.py); this file
// parses the CLI spec and knows which API key each provider needs, so we can fail before a browser starts.
import type { LlmConfig, LlmProvider } from './drivers/types.js';

// Env vars that can hold each provider's key: at least one must be set. [] = no key needed.
const KEY_ENV: Record<LlmProvider, string[]> = {
  ollama: [], // local
  openrouter: ['OPENROUTER_API_KEY'],
  vercel: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  'openai-compatible': [], // only if you set apiKeyEnv (LM Studio / vLLM / llama.cpp need none)
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY'],
  'browser-use': ['BROWSER_USE_API_KEY'],
  scripted: [], // test fake
};

export const LLM_PROVIDERS = Object.keys(KEY_ENV) as LlmProvider[];

/**
 * "provider:model" -> LlmConfig. Splits on the FIRST ':' only, because model names contain colons:
 * "ollama:qwen3:8b", "openrouter:meta-llama/llama-3.3-70b-instruct:free".
 */
export function parseLlmSpec(spec: string): LlmConfig {
  const i = spec.indexOf(':');
  const provider = (i < 0 ? spec : spec.slice(0, i)).trim();
  const model = i < 0 ? '' : spec.slice(i + 1).trim();
  if (!LLM_PROVIDERS.includes(provider as LlmProvider)) {
    throw new Error(`unknown LLM provider "${provider}" (expected one of: ${LLM_PROVIDERS.join(', ')})`);
  }
  if (!model) throw new Error(`--llm "${spec}" has no model; use provider:model, e.g. ollama:qwen3:8b`);
  return { provider: provider as LlmProvider, model };
}

/** Env vars of which at least one must be set for this LLM ([] when none is needed). */
export function requiredEnv(llm: LlmConfig): string[] {
  if (llm.apiKeyEnv) return [llm.apiKeyEnv];
  return KEY_ENV[llm.provider];
}

/** Problems that would only surface later in Python; null when the config looks usable. */
export function checkLlm(llm: LlmConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!LLM_PROVIDERS.includes(llm.provider)) return `unknown LLM provider "${llm.provider}"`;
  if (!llm.model) return `LLM ${llm.provider} has no model`;
  if (llm.provider === 'openai-compatible' && !llm.baseUrl) {
    return 'openai-compatible needs a server URL: --llm-base-url http://localhost:1234/v1 (or set baseUrl in config.ts)';
  }
  const need = requiredEnv(llm);
  if (need.length > 0 && !need.some((k) => env[k])) {
    return `${describe(llm)} needs ${need.join(' or ')} (add it to .env)`;
  }
  return null;
}

export function describe(llm: LlmConfig): string {
  return `${llm.provider}:${llm.model}`;
}

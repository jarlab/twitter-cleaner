// Defaults for the bot. Edit freely; CLI flags win over these (and DRIVER in the env picks the driver).
import path from 'node:path';
import type { BrowserUseConfig } from './drivers/types.js';

export const BOT_DIR = path.resolve(import.meta.dirname, '..');
export const ROOT = path.resolve(BOT_DIR, '..');
const BU_DIR = path.join(BOT_DIR, 'browser-use');

export type DriverChoice = 'playwright' | 'browser-use';

export type Config = {
  driver: DriverChoice;
  run: { limit: number; minDelay: number; maxDelay: number; maxIdleScrolls: number; smoothScroll: boolean };
  playwright: {
    profileDir: string;
    headless: boolean;
    viewport: { width: number; height: number };
    settleMs: number; // wait after each scroll for X to load more posts
    menuTimeoutMs: number; // how long a post's "More" menu may take to open
    homeUrl?: string; // tests point this at the fixture; default SITE.homeUrl
  };
  browserUse: BrowserUseConfig & {
    python: string[]; // command that starts the sidecar (bot/browser-use/server.py)
    rpcTimeoutMs: number; // per markNotInterested call (an agent run can take a while)
    homeUrl?: string;
  };
};

// A function, so callers (and tests) can change their copy without touching anyone else's.
export function defaultConfig(): Config {
  return {
    driver: 'playwright',
    run: { limit: 50, minDelay: 1500, maxDelay: 4000, maxIdleScrolls: 10, smoothScroll: true },
    playwright: {
      // Persistent profile: you log in once by hand, the session is reused afterwards.
      profileDir: path.join(BOT_DIR, '.profile'),
      headless: false,
      viewport: { width: 1200, height: 900 },
      settleMs: 1500,
      menuTimeoutMs: 3000,
    },
    browserUse: {
      // Its own profile (log in once more). The path must not contain "chrome": browser-use would
      // silently copy such a profile to a temp dir and forget the login.
      profileDir: path.join(BOT_DIR, '.profile-bu'),
      headless: false,
      window: { width: 1200, height: 900 },
      settleMs: 1500,
      menuTimeoutMs: 3000,
      hide: 'auto', // script: never an LLM | auto: agent only when the script path breaks | agent: always
      // Free and local by default: `ollama pull qwen3:8b`. Or e.g. --llm openrouter:<model>:free
      llm: { provider: 'ollama', model: 'qwen3:8b' },
      maxAgentRuns: 20,
      maxUsd: 2,
      maxStepsPerHide: 4,
      agentTimeoutS: 90,
      python: ['uv', 'run', '--quiet', '--project', BU_DIR, 'python', path.join(BU_DIR, 'server.py')],
      rpcTimeoutMs: 150_000,
    },
  };
}

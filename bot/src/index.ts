// Reads your X "For you" feed post by post, classifies each post with TypeSafe Jev, and marks the
// ones your classifier flags as "Not interested". This file is only the CLI and the wiring:
// the loop is in run.ts, the browser in drivers/, the defaults in config.ts.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadClassifier, shouldHide } from './classifier.js';
import { defaultConfig, ROOT, type DriverChoice } from './config.js';
import { createDriver, DRIVERS } from './drivers/index.js';
import type { HideMode, LlmConfig } from './drivers/types.js';
import { checkLlm, describe, LLM_PROVIDERS, parseLlmSpec } from './llm.js';
import { appendDecision } from './log.js';
import { run } from './run.js';
import { systemOne } from './typesafe.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env: rely on the real environment
}

const cfg = defaultConfig();
const HIDE_MODES: HideMode[] = ['script', 'auto', 'agent'];

// parseArgs throws on unknown flags; show that as a one-line error, not a stack trace.
function parseCli() {
  try {
    return parseArgs({
      options: {
        driver: { type: 'string' },
        hide: { type: 'string' },
        llm: { type: 'string' },
        'llm-base-url': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        rehearse: { type: 'boolean', default: false },
        limit: { type: 'string', default: String(cfg.run.limit) },
        'min-delay': { type: 'string', default: String(cfg.run.minDelay) },
        'max-delay': { type: 'string', default: String(cfg.run.maxDelay) },
        classifier: { type: 'string', default: path.join(ROOT, 'classifier.json') },
        log: { type: 'string', default: path.join(ROOT, 'data/decisions.jsonl') },
        headless: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (err) {
    die(`${(err as Error).message}\nSee --help.`);
  }
}
const args = parseCli();

if (args.help) {
  console.log(`Usage: npm start -- [options]      (npm run start:bu -- [options] for browser-use)
  --driver NAME        ${DRIVERS.join(' | ')} (default: $DRIVER or ${cfg.driver})
  --hide MODE          browser-use only: script (never an LLM) | auto (agent only when the
                       script breaks) | agent (always) (default ${cfg.browserUse.hide})
  --llm PROVIDER:MODEL browser-use agent's LLM (default ${describe(cfg.browserUse.llm)}), e.g.
                       ollama:qwen3:8b, openrouter:meta-llama/llama-3.3-70b-instruct:free,
                       vercel:openai/gpt-4o-mini, groq:llama-3.3-70b-versatile
                       providers: ${LLM_PROVIDERS.filter((p) => p !== 'scripted').join(', ')}
  --llm-base-url URL   server for openai-compatible (LM Studio, vLLM, llama.cpp) or an Ollama host
  --dry-run            classify and log, but never open a menu (no LLM either)
  --rehearse           open the menu and find the item, then press Escape instead of clicking
  --limit N            stop after classifying N posts (default ${cfg.run.limit})
  --min-delay MS       min time per post, including our own work (default ${cfg.run.minDelay})
  --max-delay MS       max time per post (default ${cfg.run.maxDelay})
  --classifier FILE    classifier config (default ../classifier.json)
  --log FILE           where to append decisions (default ../data/decisions.jsonl)
  --headless           no browser window (only once you are logged in)
Ctrl-C once: stop after the current post. Again (a second later or more): close the browser now.`);
  process.exit(0);
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function count(flag: 'limit' | 'min-delay' | 'max-delay'): number {
  const raw = args[flag]!;
  if (!/^\d+$/.test(raw)) die(`--${flag} must be a whole number >= 0, got "${raw}"`);
  return Number(raw);
}

// ---------------------------------------------------------------- options (CLI > env > config.ts)

const driverName = (args.driver ?? process.env.DRIVER ?? cfg.driver) as DriverChoice;
if (!DRIVERS.includes(driverName)) die(`--driver must be ${DRIVERS.join(' or ')}, got "${driverName}"`);

const dryRun = args['dry-run'];
const rehearse = args.rehearse;
if (dryRun && rehearse) die('--dry-run and --rehearse are mutually exclusive');

cfg.run.limit = count('limit');
cfg.run.minDelay = count('min-delay');
cfg.run.maxDelay = count('max-delay');
if (cfg.run.minDelay > cfg.run.maxDelay) die('--min-delay must not be larger than --max-delay');

if (args.headless) cfg.playwright.headless = cfg.browserUse.headless = true;

if (driverName !== 'browser-use' && (args.hide || args.llm || args['llm-base-url'])) {
  die('--hide, --llm and --llm-base-url only apply to --driver browser-use');
}
if (args.hide) {
  if (!HIDE_MODES.includes(args.hide as HideMode)) die(`--hide must be ${HIDE_MODES.join(', ')}, got "${args.hide}"`);
  cfg.browserUse.hide = args.hide as HideMode;
}
if (dryRun) cfg.browserUse.hide = 'script'; // a dry run never opens a menu, so no LLM is needed
if (args.llm) {
  try {
    cfg.browserUse.llm = parseLlmSpec(args.llm);
  } catch (err) {
    die((err as Error).message);
  }
}
if (args['llm-base-url']) cfg.browserUse.llm.baseUrl = args['llm-base-url'];

// ---------------------------------------------------------------- checks, before any browser starts

const classifier = loadClassifier(args.classifier);
if (!process.env.TYPESAFE_API_KEY) die('TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key.');

const agentCanRun = driverName === 'browser-use' && cfg.browserUse.hide !== 'script';
let llm: LlmConfig | null = null;
if (agentCanRun) {
  llm = cfg.browserUse.llm;
  const problem = checkLlm(llm);
  if (problem) die(`${problem}\n(or run with --hide script to never use an LLM)`);
}

// ---------------------------------------------------------------- run

const driver = await createDriver(driverName, cfg);

// First Ctrl-C: finish the current post, then stop. Second: close the browser and quit.
// Under `npm run`, one Ctrl-C arrives twice: the terminal signals the whole process group, and npm
// forwards its own copy to us a few ms later. So a SIGINT within CTRL_C_ECHO_MS of the first is that
// echo, not a second press.
const CTRL_C_ECHO_MS = 1000;
let stopRequestedAt: number | null = null;
process.on('SIGINT', () => {
  if (stopRequestedAt === null) {
    stopRequestedAt = Date.now();
    console.log('\nStopping after the current post (Ctrl-C again to quit now)...');
    return;
  }
  if (Date.now() - stopRequestedAt < CTRL_C_ECHO_MS) return;
  void driver.close().finally(() => process.exit(130));
});

console.log(
  `driver: ${driverName}` +
    (driverName === 'browser-use' ? `, hide: ${cfg.browserUse.hide}${llm ? `, llm: ${describe(llm)}` : ''}` : '') +
    (dryRun ? ' (dry run)' : rehearse ? ' (rehearsal: nothing is clicked)' : ''),
);

try {
  const result = await run(
    {
      driver,
      classify: (post) =>
        systemOne({
          model: classifier.model,
          questions: classifier.questions,
          state: { author: post.author, text: post.text, quoted_post: post.quoted },
        }),
      shouldHide: (answers) => shouldHide(classifier, answers),
      log: (d) => appendDecision(args.log, d),
      onLine: (line) => console.log(line),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      shouldStop: () => stopRequestedAt !== null,
    },
    {
      ...cfg.run,
      dryRun,
      rehearse,
      classifierVersion: classifier.version,
      hideMode: driverName === 'browser-use' ? cfg.browserUse.hide : null,
      llm: llm ? describe(llm) : null,
    },
  );
  const note = rehearse ? ' (rehearsal: nothing clicked)' : '';
  console.log(`\nClassified ${result.classified}, marked ${result.hidden} as not interested${note}. Log: ${args.log}`);
  if (result.stats) console.log(`Agent runs: ${result.stats.agentRuns}, LLM cost: $${result.stats.costUsd.toFixed(4)}`);
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await driver.close();
}

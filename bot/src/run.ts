// The bot's policy: walk the feed post by post, classify, maybe hide, pause, move on.
// It imports no browser library: everything it touches is injected, so tests drive it with FakeDriver.
import type { DriverStats, FeedDriver, HideMode, HideResult, Post } from './drivers/types.js';
import type { DecisionV2 } from './log.js';
import type { Answer } from './typesafe.js';

export type RunDeps = {
  driver: FeedDriver;
  classify: (post: Post) => Promise<{ model: string; answers: Record<string, Answer> }>;
  shouldHide: (answers: Record<string, Answer>) => boolean;
  log: (d: DecisionV2) => void;
  onLine: (line: string) => void; // progress output (console.log in the CLI)
  sleep: (ms: number) => Promise<void>;
  now: () => number; // ms
  shouldStop: () => boolean; // Ctrl-C was pressed once
  random?: () => number; // [0, 1), for the reading pause
};

export type RunOptions = {
  limit: number; // stop after classifying this many posts
  minDelay: number; // ms per classified post, including the time spent on it
  maxDelay: number;
  maxIdleScrolls: number; // stop after this many scrolls in a row that show nothing new
  dryRun: boolean; // classify and log, never open a menu
  rehearse: boolean; // walk the menu and find the item, but press Escape instead of clicking
  classifierVersion: number;
  hideMode: HideMode | null; // logged as-is (null for playwright)
  llm: string | null; // "provider:model" when the agent could run, logged as-is
};

export type RunResult = {
  classified: number;
  hidden: number;
  stats: DriverStats | null;
  error: string | null; // why the run stopped early, if it was a failure
};

// Failures that say nothing about the driver being broken (virtualised post, ad without the item).
const BENIGN = new Set(['not_found', 'no_menu_item']);
const MAX_STRIKES = 3;

export async function run(deps: RunDeps, opts: RunOptions): Promise<RunResult> {
  const { driver, onLine } = deps;
  const random = deps.random ?? Math.random;

  const { handle } = await driver.open({ onPrompt: onLine });
  if (!handle) onLine('warning: could not read your handle, so your own posts will not be skipped');

  const seen = new Set<string>();
  const queue: Post[] = [];
  let classified = 0;
  let hidden = 0;
  let idle = 0;
  let strikes = 0;
  let error: string | null = null;

  while (classified < opts.limit && idle < opts.maxIdleScrolls && !deps.shouldStop()) {
    if (queue.length === 0) {
      const fresh = (await driver.readVisiblePosts()).filter((p) => !seen.has(p.id));
      if (fresh.length === 0) {
        await driver.scroll();
        idle++;
        continue;
      }
      idle = 0;
      for (const p of fresh) seen.add(p.id);
      queue.push(...fresh); // feed order
    }
    const post = queue.shift()!;
    const started = deps.now();

    // "Move to the next post": every post gets scrolled to the top, even ones we skip.
    await driver.focus(post.id);
    if ((handle && post.author.toLowerCase() === handle) || !post.text.trim()) continue; // own / media-only

    let model: string;
    let answers: Record<string, Answer>;
    let hide: boolean;
    try {
      ({ model, answers } = await deps.classify(post));
      hide = deps.shouldHide(answers);
    } catch (err) {
      onLine(`  classify failed for ${post.id}: ${(err as Error).message}`);
      continue;
    }
    classified++;

    let act: HideResult | null = null;
    if (hide && !opts.dryRun) {
      act = await driver
        .markNotInterested(post.id, { commit: !opts.rehearse })
        .catch((err: Error): HideResult => ({ ok: false, via: null, reason: 'error', fatal: true, detail: err.message }));
      strikes = act.ok || BENIGN.has(act.reason ?? '') ? 0 : strikes + 1;
    }
    const acted = !!act && act.ok && !act.rehearsed;
    if (acted) hidden++;

    onLine(`${tag(hide, opts.dryRun, act)}  @${post.author}: ${post.text.replace(/\s+/g, ' ').slice(0, 70)}${cost(act)}`);
    if (act && !act.ok && act.detail) onLine(`      ${act.detail}`);
    deps.log({
      v: 2,
      at: new Date(deps.now()).toISOString(),
      post_id: post.id,
      author: post.author,
      text: post.text,
      quoted: post.quoted,
      classifier_version: opts.classifierVersion,
      model,
      answers,
      hide,
      acted,
      dry_run: opts.dryRun,
      rehearse: opts.rehearse,
      driver: driver.name,
      hide_mode: opts.hideMode,
      llm: opts.llm,
      via: act?.via ?? null,
      fail_reason: act && !act.ok ? (act.reason ?? 'error') : null,
      menu_label: act?.label ?? null,
      agent_cost_usd: act?.costUsd ?? null,
    });

    if (act?.fatal) {
      error = `stopping: ${act.reason ?? 'error'} on post ${post.id}${act.detail ? ` (${act.detail})` : ''}`;
      break;
    }
    if (act?.reason === 'budget') {
      // Not markup drift: the cap in config.ts was reached, and every later agent run would be refused too.
      error =
        `stopping: the agent budget is used up${act.detail ? ` (${act.detail})` : ''}; ` +
        'raise maxAgentRuns / maxUsd in src/config.ts, or run with --hide script';
      break;
    }
    if (strikes >= MAX_STRIKES) {
      error = `stopping: ${MAX_STRIKES} failed hides in a row (last: ${act?.reason}); X's markup may have changed, see src/site/x.json`;
      break;
    }

    // Reading time: the whole post takes between minDelay and maxDelay, not that plus our own work.
    if (classified < opts.limit && !deps.shouldStop()) {
      const pause = opts.minDelay + random() * (opts.maxDelay - opts.minDelay);
      const wait = pause - (deps.now() - started);
      if (wait > 0) await deps.sleep(wait);
    }
  }

  const stats = await driver.stats().catch(() => null);
  return { classified, hidden, stats, error };
}

function tag(hide: boolean, dryRun: boolean, act: HideResult | null): string {
  if (!hide) return 'keep';
  if (dryRun) return 'DRY ';
  if (!act?.ok) return `FAIL(${act?.reason ?? 'error'})`;
  return act.rehearsed ? 'TRY ' : 'HIDE';
}

function cost(act: HideResult | null): string {
  return act?.costUsd != null ? ` [$${act.costUsd.toFixed(4)}]` : '';
}

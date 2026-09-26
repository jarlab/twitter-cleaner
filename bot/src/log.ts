// One line of data/decisions.jsonl: the contract between the bot and analysis/.
// analysis/decisions.py has the matching Python types (and upgrades v1 rows to v2 when reading);
// change them together, and bump `v` on breaking changes.
import fs from 'node:fs';
import path from 'node:path';
import type { DriverName, FailReason, HideMode } from './drivers/types.js';
import type { Answer } from './typesafe.js';

/** What the bot wrote before drivers existed. Still read by analysis/decisions.py. */
export type DecisionV1 = {
  v: 1;
  at: string; // ISO timestamp
  post_id: string;
  author: string;
  text: string;
  quoted: string | null;
  classifier_version: number;
  model: string; // exact model version that answered, e.g. "jev-1.13.0"
  answers: Record<string, Answer>;
  hide: boolean;
  acted: boolean; // "Not interested" was actually clicked
  dry_run: boolean;
};

export type DecisionV2 = {
  v: 2;
  at: string; // ISO timestamp
  post_id: string;
  author: string;
  text: string;
  quoted: string | null;
  classifier_version: number;
  model: string; // exact Jev model version that answered, e.g. "jev-1.13.0"
  answers: Record<string, Answer>;
  hide: boolean;
  acted: boolean; // "Not interested" was actually clicked (ok and not a rehearsal)
  dry_run: boolean;
  rehearse: boolean; // --rehearse: the menu was walked but nothing clicked
  driver: DriverName;
  hide_mode: HideMode | null; // browser-use only; null for playwright
  llm: string | null; // "provider:model" when the agent could run, else null
  via: 'script' | 'agent' | null; // which path did the hiding (null: nothing attempted)
  fail_reason: FailReason | null;
  menu_label: string | null; // menu item clicked (or that would have been, when rehearsing)
  agent_cost_usd: number | null; // LLM spend on this post (agent path only)
};

export function appendDecision(file: string, d: DecisionV2): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(d) + '\n');
}

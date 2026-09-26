// One line of data/decisions.jsonl: the contract between the bot and analysis/.
// analysis/decisions.py has the matching Python type; bump `v` on breaking changes.
import fs from 'node:fs';
import type { Answer } from './typesafe.js';

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

export function appendDecision(file: string, d: DecisionV1): void {
  fs.appendFileSync(file, JSON.stringify(d) + '\n');
}

// Loads the shared classifier.json and evaluates its hide_if rule.
// analysis/decisions.py mirrors should_hide(); keep the two in sync.
import fs from 'node:fs';
import type { Answer, Question } from './typesafe.js';

export type Condition = {
  question: string;
  field: 'noul' | 'score' | 'choice' | 'confidence';
  op: '>=' | '<=' | '>' | '<' | '==' | 'in';
  value: number | string | string[];
};
export type Rule = { any: Condition[] } | { all: Condition[] };

export type Classifier = {
  version: number;
  model: string;
  questions: Record<string, Question>;
  hide_if: Rule;
};

const FIELDS: Record<Question['type'], Condition['field'][]> = {
  noul: ['noul'],
  choice: ['choice', 'confidence'],
  score: ['score', 'confidence'],
};

export function loadClassifier(file: string): Classifier {
  const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Classifier;
  const conditions = 'any' in c.hide_if ? c.hide_if.any : c.hide_if.all;
  for (const cond of conditions) {
    const q = c.questions[cond.question];
    if (!q) throw new Error(`hide_if refers to unknown question "${cond.question}"`);
    if (!FIELDS[q.type].includes(cond.field)) {
      throw new Error(`"${cond.question}" is a ${q.type} question; it has no "${cond.field}" field`);
    }
  }
  return c;
}

function matches(cond: Condition, answers: Record<string, Answer>): boolean {
  const answer = answers[cond.question] as Record<string, unknown> | undefined;
  const actual = answer?.[cond.field];
  if (actual === undefined) return false;
  switch (cond.op) {
    case '==': return actual === cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(actual as string);
    case '>=': return (actual as number) >= (cond.value as number);
    case '<=': return (actual as number) <= (cond.value as number);
    case '>': return (actual as number) > (cond.value as number);
    case '<': return (actual as number) < (cond.value as number);
  }
}

export function shouldHide(c: Classifier, answers: Record<string, Answer>): boolean {
  return 'any' in c.hide_if
    ? c.hide_if.any.some((cond) => matches(cond, answers))
    : c.hide_if.all.every((cond) => matches(cond, answers));
}

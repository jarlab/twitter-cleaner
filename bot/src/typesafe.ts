// Minimal typed client for TypeSafe's System One API (docs: https://docs.typesafe.ai/api.md)
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type JSONContent = string | number | boolean | null | JSONContent[] | { [key: string]: JSONContent };

export type NoulQuestion = {
  type: 'noul';
  instructions: JSONContent;
  criteria?: { true?: JSONContent; false?: JSONContent };
};
export type ChoiceQuestion = { type: 'choice'; instructions: JSONContent; criteria: Record<string, JSONContent> };
export type ScoreQuestion = { type: 'score'; instructions: JSONContent; criteria: JSONContent[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type ScoreAnswer = {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, JSONContent>;
  probabilities: Record<string, number>;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function systemOne(
  req: { state: JSONContent; questions: Record<string, Question>; model: string },
  { retries = 4 } = {},
): Promise<SystemOneResponse> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set (copy .env.example to .env)');

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (res.ok) return (await res.json()) as SystemOneResponse;

    // 429 = rate limited, 529 = overloaded: back off and retry
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter ? retryAfter * 1000 : 2 ** attempt * 1000);
      continue;
    }
    throw new Error(`TypeSafe ${res.status}: ${await res.text()}`);
  }
}

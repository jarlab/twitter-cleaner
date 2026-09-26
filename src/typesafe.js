// Minimal client for TypeSafe's System One API (docs: https://docs.typesafe.ai/api.md)
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function systemOne({ state, questions, model = 'jev-latest' }, { retries = 4 } = {}) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set (copy .env.example to .env)');

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model, questions }),
    });
    if (res.ok) return res.json();

    // 429 = rate limited, 529 = overloaded: back off and retry
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter ? retryAfter * 1000 : 2 ** attempt * 1000);
      continue;
    }
    throw new Error(`TypeSafe ${res.status}: ${await res.text()}`);
  }
}

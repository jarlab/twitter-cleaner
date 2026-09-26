# twitter-cleaner

A learning project: reads your X "For you" feed in a real browser, classifies each post with
[TypeSafe Jev](https://docs.typesafe.ai), and clicks **Not interested in this post** on the ones your
classifier flags. Then analyse the decisions in Python to tune the classifier.

> Automating x.com is against X's Terms of Service. This is for personal experimentation on your own
> account; keep volumes low and expect that X may rate-limit or lock the account.

```
classifier.json        # shared: Jev questions + hide_if rule (read by both sides)
bot/        TypeScript  # browser loop: read feed -> classify -> click
analysis/   Python      # pandas/notebook + replay of past posts through new classifiers
data/                   # decisions.jsonl (gitignored) — the contract between the two
```

## Setup

```bash
cp .env.example .env                     # paste your key from console.typesafe.ai/keys
(cd bot && npm install && npx playwright install chromium)
(cd analysis && uv sync)
```

## Run the bot (TypeScript)

```bash
cd bot
npm run dry -- --limit 20   # classify + log only, no clicks
npm start -- --limit 20     # actually mark posts as not interested
npm run typecheck
```

The first run opens a browser window: log in to X yourself. The session is saved in `bot/.profile/`.
Every decision is appended to `data/decisions.jsonl`.

## Analyse (Python)

```bash
cd analysis
uv run jupyter lab explore.ipynb                  # distributions, threshold sweep, hand labels
uv run --env-file ../.env replay.py --limit 100   # re-run past posts through classifier.json
```

`replay.py` is the fast loop for improving the classifier: edit `classifier.json`, replay, and see
which decisions flip — no browser needed. Results go to `data/replay-<timestamp>.jsonl`.

## The classifier

`classifier.json` has:

- `questions` — Jev questions (`noul`, `choice`, `score`), sent as-is to the API.
- `hide_if` — `{"any": [...]}` or `{"all": [...]}` of conditions, each
  `{"question", "field", "op", "value"}`. Fields: `noul` (noul), `choice` / `confidence` (choice),
  `score` / `confidence` (score). Ops: `>=`, `<=`, `>`, `<`, `==`, `in`.
- `version` — bump it when you change the classifier; it's recorded in every decision.

Each post is sent to Jev as `{ author, text, quoted_post }`.

## Log format

One JSON object per line, `v: 1` — see `bot/src/log.ts` (`DecisionV1`) and its Python mirror in
`analysis/decisions.py`. The hide rule is also implemented on both sides
(`bot/src/classifier.ts`, `analysis/decisions.py`); change them together.

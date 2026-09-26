# twitter-cleaner

A learning project: reads your X "For you" feed in a real browser, post by post, classifies each post
with [TypeSafe Jev](https://docs.typesafe.ai), and clicks **Not interested in this post** on the ones
your classifier flags. Then analyse the decisions in Python to tune the classifier.

> Automating x.com is against X's Terms of Service. This is for personal experimentation on your own
> account; keep volumes low and expect that X may rate-limit or lock the account.

```
classifier.json        # shared: Jev questions + hide_if rule (read by both sides)
bot/        TypeScript  # browser loop: read feed -> classify -> click
  src/site/x.json       #   every X selector and menu text (the only file that knows X's markup)
  browser-use/          #   Python sidecar, only for --driver browser-use
analysis/   Python      # pandas/notebook + replay of past posts through new classifiers
data/                   # decisions.jsonl (gitignored) — the contract between the two
```

## Setup

```bash
cp .env.example .env                     # paste your key from console.typesafe.ai/keys
(cd bot && npm install && npx playwright install chromium)
(cd analysis && uv sync)
(cd bot && npm run setup:bu)             # optional: only for --driver browser-use (needs uv)
```

`setup:bu` syncs the Python project in `bot/browser-use/` (it pins `browser-use==0.13.10`) and
installs the Chromium it drives. You never start the Python side yourself: the bot spawns it.

## Run the bot (TypeScript)

```bash
cd bot
npm run dry -- --limit 20      # classify + log only, no clicks
npm start -- --rehearse        # open the menu and find the item, but press Escape instead of clicking
npm start -- --limit 20        # actually mark posts as not interested
npm run dry:bu                 # same as dry / start, with --driver browser-use
npm run start:bu
npm test                       # see "Tests" below
npm run typecheck
```

The first run opens a browser window: log in to X yourself (the bot never types credentials). Each
driver keeps its own session: `bot/.profile/` for Playwright, `bot/.profile-bu/` for Browser Use, so
you log in once per driver. Every decision is appended to `data/decisions.jsonl`.

### How a run moves through the feed

The bot handles **one post at a time**. For each post it:

1. scrolls that post to the top of the window (just under X's sticky header) and outlines it in blue,
   so you can follow along;
2. skips it if it's your own post or has no text (media only) — not classified, not logged;
3. classifies it with Jev and, if `hide_if` matches, opens its menu and chooses "Not interested";
4. pauses for a random "reading time" (`--min-delay`..`--max-delay`, minus the time already spent);
5. moves on to the next post.

When the posts on screen are used up it scrolls about a screen further to load more, and stops after
10 scrolls in a row with nothing new, after `--limit` classified posts, or on Ctrl-C (first press:
stop after the current post; another press a second or more later: close the browser and exit).

Every click is keyed by the post's id, and the post is found again right before clicking, so an X
re-render can't send the click to a different post. Expected misses (a post scrolled out of the DOM,
an ad whose menu has no "Not interested") are logged and skipped; three other failures in a row stop
the run, and a hide that removed the *wrong* post stops it immediately (so does a used-up agent budget).

### Options

| Flag | Default | |
| --- | --- | --- |
| `--driver playwright\|browser-use` | `playwright` | which browser layer (also `DRIVER=` in the env) |
| `--hide script\|auto\|agent` | `auto` | browser-use only, see [Hide modes](#hide-modes) |
| `--llm provider:model` | `ollama:qwen3:8b` | browser-use agent's model, see [LLM providers](#llm-providers) |
| `--llm-base-url URL` | | server URL (required for `openai-compatible`; overrides the Ollama host) |
| `--dry-run` | | classify and log, never open a menu (forces `--hide script`, no LLM) |
| `--rehearse` | | walk the menu, find the item, press Escape; never click (not with `--dry-run`) |
| `--limit N` | `50` | stop after classifying N posts |
| `--min-delay MS` / `--max-delay MS` | `1500` / `4000` | reading pause per post |
| `--classifier FILE` | `../classifier.json` | |
| `--log FILE` | `../data/decisions.jsonl` | |
| `--headless` | | no visible window (only works once you're logged in) |

Defaults live in `bot/src/config.ts` (typed, meant to be edited). Precedence: CLI flag > `DRIVER`
env var > `config.ts`. Keys are checked before any browser starts.

## Drivers

Both drivers read the feed the same way — a small script evaluated in the page (`bot/src/site/x.inpage.js`,
driven by the selectors in `x.json`), no LLM — and both move post by post as described above.
They differ in how the browser is driven and what happens when X changes its markup.

| | `playwright` (default) | `browser-use` |
| --- | --- | --- |
| Runs | in the Node process | a Python sidecar (`bot/browser-use/server.py`) over JSON lines on stdio |
| Needs | nothing extra | `uv` + `npm run setup:bu` |
| Hiding | script only | `script`, `auto` or `agent` (an LLM operates the post's menu) |
| If X renames a button | the hide fails (`caret_missing`, ...) until you fix `x.json` | `auto` falls back to the agent |

Pick **playwright** for the simplest, fastest, LLM-free run. Pick **browser-use** when you want the
LLM fallback for selector drift, or to learn how a browser agent behaves on a tightly fenced task.

### Hide modes

Only for `--driver browser-use` (Playwright always uses the script; its log rows have `hide_mode: null`).

- `script` — deterministic only: find the post's "More" button, open the menu, click the item. No LLM.
- `auto` (default) — the script first; the agent is called only when the script looks broken by
  markup drift (`caret_missing`, `menu_not_opened`, or a third `no_menu_item` in a row).
- `agent` — the agent handles every hide (mostly for testing the agent).

The agent is fenced: its task names only the post id and the post's button labels, and it gets only
three tools — press one of that post's numbered buttons, choose a label from the menu that actually
opened, or say there's no matching item. It can't navigate or type. Only "not interested" wordings
(`guard.allowMenu` in `x.json`, English plus a few other languages) can be chosen; anything else,
including Block / Mute / Report / Follow in any language and anything with an `@`, is refused, and at
most one item is clicked per post. If your X is in a language `allowMenu` doesn't cover, add its
wording there. Code, not the agent, then checks the result (the post is gone, no other post vanished,
still on the feed).
Privacy: the model never sees post text. browser-use's page snapshot is switched off (the model reads
"empty page") and no screenshots are sent; it only gets the post id, the button labels and the menu
labels. browser-use does save a screenshot per agent step under `$TMPDIR/browser_use_agent_*`; the
sidecar deletes that folder after each run.
Budgets per run in `config.ts`: `maxAgentRuns` 20, `maxUsd` $2, `maxStepsPerHide` 4,
`agentTimeoutS` 90. When they are used up, the refused hide is logged as `budget` and the run stops.

## LLM providers

The LLM is only used by the browser-use agent. Classification is always TypeSafe Jev. Pass
`--llm provider:model`; only the first `:` separates the two, so model ids may contain colons.
Put the key in `.env` (see `.env.example`).

| Provider | Key env var | Cost | `--llm` example |
| --- | --- | --- | --- |
| `ollama` | none (`OLLAMA_HOST` or `--llm-base-url` if not on localhost:11434) | free, local | `ollama:qwen3:8b` |
| `openrouter` | `OPENROUTER_API_KEY` | `:free` model variants cost $0 (rate-limited); others per token | `openrouter:<vendor>/<model>:free` |
| `groq` | `GROQ_API_KEY` | free tier (rate-limited) | `groq:<model-id>` |
| `cerebras` | `CEREBRAS_API_KEY` | free tier (rate-limited) | `cerebras:<model-id>` |
| `openai-compatible` | none, or the env var named by `apiKeyEnv` in `config.ts` | free if you host it | `openai-compatible:<model>` + `--llm-base-url` |
| `vercel` (AI Gateway) | `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`) | per token | `vercel:<creator>/<model>` |
| `openai` | `OPENAI_API_KEY` | per token | `openai:<model>` |
| `anthropic` | `ANTHROPIC_API_KEY` | per token | `anthropic:<model>` |
| `google` | `GOOGLE_API_KEY` | per token | `google:<model>` |
| `browser-use` (Browser Use cloud) | `BROWSER_USE_API_KEY` | per token | `browser-use:<model>` |
| `scripted` | none | $0, no network | `scripted:happy` (fake model for tests) |

Model ids and free tiers change often; look them up on the provider's model list
(e.g. [openrouter.ai/models](https://openrouter.ai/models) and filter for `:free` variants).

```bash
# Local and free: install Ollama, then
ollama pull qwen3:8b
npm run start:bu -- --llm ollama:qwen3:8b --rehearse

# OpenRouter free variant (pick a current ':free' id from openrouter.ai/models), e.g.
npm run start:bu -- --llm openrouter:meta-llama/llama-3.3-70b-instruct:free

# Any OpenAI-compatible server: LM Studio (:1234), vLLM (:8000), llama.cpp server (:8080), ...
npm run start:bu -- --llm openai-compatible:<model> --llm-base-url http://localhost:1234/v1

# Never call an LLM
npm run start:bu -- --hide script
```

For Ollama the sidecar checks before opening the browser that the server answers and the model is
pulled, and fails with a clear message otherwise. Small local models can struggle with tool calling
(wrong tool, or giving up — logged as `gave_up`): try a new model with `--rehearse` first, and keep
`--hide auto` so the agent is only needed when the script breaks. The `maxUsd` cap uses the cost
browser-use reports, or `llm.prices` (USD per 1M tokens) if you set it in `config.ts`. For `ollama` and
`openai-compatible` only `llm.prices` counts ($0 when unset).

## Rehearse mode

`--rehearse` does everything a real run does for a flagged post — find it by id, open its menu (by
script or agent), find the "Not interested" item — then presses Escape instead of clicking. The post
stays in your feed. Rows are logged with `rehearse: true`, `acted: false` and the `menu_label` that
would have been clicked. Use it to check a new driver, hide mode or model safely. (`--dry-run` goes
less far: it never opens a menu.)

## Tests

```bash
cd bot
npm test          # node --test via tsx; headless, never touches x.com, needs no keys
```

The tests run the loop against a fake driver and both drivers against a local imitation of X
(`bot/test/fixtures/fake_x.html`, with variants for logged-out, renamed buttons, re-rendering and a
menu with only Mute/Block/Report). The browser-use tests are skipped if `bot/browser-use/.venv` is
missing (run `npm run setup:bu`); its agent tests use the `scripted` fake model, so they cost nothing.

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

One JSON object per line, `v: 2` (`DecisionV2` in `bot/src/log.ts`, mirrored in
`analysis/decisions.py`):

| Field | |
| --- | --- |
| `v`, `at` | `2`, ISO timestamp |
| `post_id`, `author`, `text`, `quoted` | the post (`quoted` is the quoted post's text or `null`) |
| `classifier_version`, `model`, `answers` | which classifier and Jev model answered, and the answers |
| `hide` | the classifier said hide |
| `acted` | "Not interested" was clicked and the post left the feed (never on a rehearsal) |
| `dry_run`, `rehearse` | the run's mode |
| `driver` | `playwright`, `browser-use` (or `fake` in tests) |
| `hide_mode` | `script` / `auto` / `agent`; `null` for playwright |
| `llm` | `"provider:model"` when the agent could run, else `null` |
| `via` | `script` or `agent`: which path did the hide; `null` if none did |
| `fail_reason` | why a hide failed (`not_found`, `caret_missing`, `menu_not_opened`, `no_menu_item`, `unverified`, `wrong_post`, `budget`, `gave_up`, `error`) or `null` |
| `menu_label` | the menu item clicked (or that would have been) |
| `agent_cost_usd` | LLM spend for this post, or `null` |

Older `v: 1` lines still load: `read_decisions` upgrades them as Playwright rows (`via: "script"`
when acted, the new fields `null`/`false`). `replay.py` writes v2 rows with every action field reset,
as in a dry run. The format and the hide rule are both implemented on both sides
(`bot/src/log.ts` + `bot/src/classifier.ts`, `analysis/decisions.py`); change them together.

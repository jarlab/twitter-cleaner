# twitter-cleaner

A learning project: reads your X "For you" feed in a real browser, classifies each post with
[TypeSafe Jev](https://docs.typesafe.ai), and clicks **Not interested in this post** on the ones your
classifier flags.

> Automating x.com is against X's Terms of Service. This is for personal experimentation on your own
> account; keep volumes low and expect that X may rate-limit or lock the account.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then paste your key from console.typesafe.ai/keys
```

## Run

```bash
npm run dry              # classify + log only, no clicks — use this to tune your classifier
npm start -- --limit 20  # actually mark posts as not interested
```

The first run opens a browser window: log in to X yourself. The session is saved in `.profile/`.

## Your classifier

Edit [`src/classifier.js`](src/classifier.js):

- `questions` — the Jev questions (`noul`, `choice`, or `score`) asked about each post.
- `shouldHide(answers)` — turns Jev's answers into a hide/keep decision.

Each post is sent as `{ author, text, quoted_post }`. Every decision (with Jev's full answers) is
appended to `decisions.jsonl`, handy for picking thresholds.

## Files

- `src/index.js` — browser loop: read feed → classify → click
- `src/typesafe.js` — tiny client for `POST https://api.typesafe.ai/v1/systemone`
- `src/classifier.js` — your questions and decision rule

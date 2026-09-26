// Reads your X "For you" feed, classifies each post with TypeSafe Jev,
// and clicks "Not interested in this post" on the ones your classifier flags.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Locator } from 'playwright';
import { systemOne } from './typesafe.js';
import { loadClassifier, shouldHide } from './classifier.js';
import { appendDecision } from './log.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env: rely on the real environment
}

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string', default: '50' },
    'min-delay': { type: 'string', default: '1500' },
    'max-delay': { type: 'string', default: '4000' },
    classifier: { type: 'string', default: path.join(ROOT, 'classifier.json') },
    log: { type: 'string', default: path.join(ROOT, 'data/decisions.jsonl') },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Usage: npm start -- [options]
  --dry-run          classify and log, but don't click anything
  --limit N          stop after classifying N posts (default 50)
  --min-delay MS     min pause after each post (default 1500)
  --max-delay MS     max pause after each post (default 4000)
  --classifier FILE  classifier config (default ../classifier.json)
  --log FILE         where to append decisions (default ../data/decisions.jsonl)`);
  process.exit(0);
}

const dryRun = args['dry-run'];
const limit = Number(args.limit);
const minDelay = Number(args['min-delay']);
const maxDelay = Number(args['max-delay']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(minDelay + Math.random() * (maxDelay - minDelay));

const classifier = loadClassifier(args.classifier);
if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

// Persistent profile: you log in once by hand, the session is reused afterwards.
const context = await chromium.launchPersistentContext(path.join(ROOT, 'bot/.profile'), {
  headless: false,
  viewport: { width: 1200, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto('https://x.com/home');
const loggedIn = '[data-testid="SideNav_AccountSwitcher_Button"]';
if (!(await page.locator(loggedIn).isVisible().catch(() => false))) {
  console.log('Log in to X in the browser window; I will continue once you are on the home feed.');
  await page.waitForSelector(loggedIn, { timeout: 0 });
}
const me = (await page.locator(`${loggedIn} [dir="ltr"] span`).last().innerText().catch(() => ''))
  .replace(/^@/, '')
  .toLowerCase();

// "Not interested" only exists on the algorithmic "For you" tab.
await page.getByRole('tab', { name: /for you/i }).click().catch(() => {});
await page.waitForSelector('article[data-testid="tweet"]');

type Post = { id: string; author: string; text: string; quoted: string | null };

function readPost(article: Locator): Promise<Post | null> {
  return article.evaluate((el) => {
    const link = [...el.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time'));
    const m = link?.getAttribute('href')?.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const texts = [...el.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')].map((n) => n.innerText);
    return { id: m[2], author: m[1], text: texts[0] ?? '', quoted: texts[1] ?? null };
  });
}

async function markNotInterested(article: Locator): Promise<boolean> {
  await article.locator('[data-testid="caret"]').first().click();
  const item = page.getByRole('menuitem').filter({ hasText: /not interested/i }).first();
  try {
    await item.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await page.keyboard.press('Escape'); // menu had no such option (e.g. an ad)
    return false;
  }
  await item.click();
  return true;
}

async function nextUnseen(seen: Set<string>): Promise<{ post: Post; article: Locator } | null> {
  // Re-query each time: the feed re-renders after every click and scroll.
  for (const article of await page.locator('article[data-testid="tweet"]').all()) {
    const post = await readPost(article).catch(() => null);
    if (post && !seen.has(post.id)) return { post, article };
  }
  return null;
}

const seen = new Set<string>();
let classified = 0;
let hidden = 0;
let idleScrolls = 0;

while (classified < limit && idleScrolls < 10) {
  const next = await nextUnseen(seen);
  if (!next) {
    idleScrolls++;
    await page.mouse.wheel(0, 1600);
    await sleep(1500);
    continue;
  }
  idleScrolls = 0;
  const { post, article } = next;
  seen.add(post.id);

  if (post.author.toLowerCase() === me || !post.text.trim()) continue; // own posts, media-only posts

  let response;
  try {
    response = await systemOne({
      model: classifier.model,
      questions: classifier.questions,
      state: { author: post.author, text: post.text, quoted_post: post.quoted },
    });
  } catch (err) {
    console.error(`  classify failed for ${post.id}: ${(err as Error).message}`);
    continue;
  }
  classified++;

  const hide = shouldHide(classifier, response.answers);
  let acted = false;
  if (hide && !dryRun) {
    acted = await markNotInterested(article).catch(() => false);
    if (acted) hidden++;
  }

  const snippet = post.text.replace(/\s+/g, ' ').slice(0, 70);
  console.log(`${hide ? (acted || dryRun ? 'HIDE' : 'FAIL') : 'keep'}  @${post.author}: ${snippet}`);
  appendDecision(args.log, {
    v: 1,
    at: new Date().toISOString(),
    post_id: post.id,
    author: post.author,
    text: post.text,
    quoted: post.quoted,
    classifier_version: classifier.version,
    model: response.model,
    answers: response.answers,
    hide,
    acted,
    dry_run: dryRun,
  });

  await pause();
}

console.log(`\nClassified ${classified}, marked ${hidden} as not interested. Log: ${args.log}`);
await context.close();

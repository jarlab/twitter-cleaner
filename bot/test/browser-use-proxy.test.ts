// The browser-use driver's Node half (src/drivers/browser-use.ts), tested against
// test/fixtures/fake-sidecar.mjs: a Node fake that speaks the sidecar protocol. No Python, no browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { defaultConfig } from '../src/config.js';
import createBrowserUseDriver, { type BrowserUseDriverConfig } from '../src/drivers/browser-use.js';
import { createDriver } from '../src/drivers/index.js';
import type { FeedDriver } from '../src/drivers/types.js';

const FAKE = path.join(import.meta.dirname, 'fixtures/fake-sidecar.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-proxy-'));
const HOME = 'http://127.0.0.1:9/home';
const LABEL = 'Not interested in this post';

// What the fake appends to its --record file: first {pid, grandchild, env}, then one {method, params, overlapped} per request.
type Rec = {
  pid: number;
  grandchild: number | null;
  env: Record<string, string | null>;
  method: string;
  params: any;
  overlapped: boolean;
};

const open: FeedDriver[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});

let n = 0;
function setup(mode: string, o: { args?: string[]; cfg?: Partial<BrowserUseDriverConfig> } = {}) {
  const recordFile = path.join(TMP, `record-${++n}.jsonl`);
  const driver = createBrowserUseDriver({
    profileDir: path.join(TMP, 'profile-bu'),
    headless: true,
    window: { width: 1200, height: 900 },
    settleMs: 0,
    menuTimeoutMs: 1000,
    hide: 'script',
    llm: { provider: 'scripted', model: 'happy' },
    maxAgentRuns: 0,
    maxUsd: 0,
    maxStepsPerHide: 4,
    agentTimeoutS: 90,
    python: [process.execPath, FAKE, mode, '--record', recordFile, ...(o.args ?? [])],
    rpcTimeoutMs: 5000,
    homeUrl: HOME,
    ...o.cfg,
  });
  open.push(driver);
  const records = (): Rec[] =>
    fs.existsSync(recordFile)
      ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
  const methods = () => records().slice(1).map((r) => r.method);
  return { driver, records, methods, recordFile };
}

const noPrompt = { onPrompt: () => assert.fail('unexpected login prompt') };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) assert.fail(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('ok: every method round-trips, one request at a time', async () => {
  const { driver, records, methods } = setup('ok');
  assert.deepEqual(await driver.open(noPrompt), { handle: 'me' });

  const posts = await driver.readVisiblePosts();
  assert.deepEqual(posts[1], { id: '1001', author: 'bob', text: 'second post', quoted: 'the quoted one' });
  assert.equal(await driver.focus('1001'), true);
  assert.equal(await driver.focus('nope'), false);
  assert.equal(await driver.scroll(), undefined);
  assert.deepEqual(await driver.markNotInterested('1000'), { ok: true, via: 'script', label: LABEL });
  assert.deepEqual(await driver.markNotInterested('1000', { commit: false }), {
    ok: true,
    via: 'script',
    rehearsed: true,
    label: LABEL,
  });
  assert.equal((await driver.markNotInterested('bogus')).reason, 'not_found');
  assert.deepEqual(await driver.stats(), { agentRuns: 0, costUsd: 0 });

  // Fired together, they still go out one after another (the fake flags any overlap).
  const [focused, again, stats] = await Promise.all([driver.focus('1000'), driver.readVisiblePosts(), driver.stats()]);
  assert.equal(focused, true);
  assert.equal(again.length, 2);
  assert.deepEqual(stats, { agentRuns: 0, costUsd: 0 });

  await driver.close();
  await driver.close(); // idempotent
  assert.deepEqual(methods(), [
    'open', 'readVisiblePosts', 'focus', 'focus', 'scroll',
    'markNotInterested', 'markNotInterested', 'markNotInterested', 'stats',
    'focus', 'readVisiblePosts', 'stats', 'close',
  ]);
  const reqs = records().slice(1);
  assert.ok(reqs.every((r) => !r.overlapped), 'a request was sent while another was in flight');
  assert.deepEqual(
    reqs.filter((r) => r.method === 'markNotInterested').map((r) => r.params),
    [{ id: '1000', commit: true }, { id: '1000', commit: false }, { id: 'bogus', commit: true }],
  );
  assert.equal(alive(records()[0].pid), false, 'sidecar still running after close()');
  await assert.rejects(driver.readVisiblePosts(), /closed/);
});

test('ok: the child env drops TYPESAFE_API_KEY, turns off .env loading and telemetry, and it gets its own process group', async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'must-not-leak';
  try {
    const { driver, records } = setup('ok');
    await driver.open(noPrompt);
    const { pid, env } = records()[0];
    // PYTHON_DOTENV_DISABLED: browser-use calls load_dotenv() on import, which would find the repo's .env
    // and put TYPESAFE_API_KEY right back.
    assert.deepEqual(env, { TYPESAFE_API_KEY: null, ANONYMIZED_TELEMETRY: 'false', PYTHON_DOTENV_DISABLED: '1' });
    assert.equal(process.env.TYPESAFE_API_KEY, 'must-not-leak', 'our own env must be untouched');
    // detached: the sidecar leads its own group, so a terminal Ctrl-C doesn't reach it (or its Chrome).
    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    assert.equal(pgid, String(pid));
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
});

test('ok: open ships the site bundle (homeUrl overridden) and the BrowserUseConfig part only', async () => {
  const { driver, records } = setup('ok');
  await driver.open(noPrompt);
  const { method, params } = records()[1];
  assert.equal(method, 'open');
  assert.equal(params.bundle.site.homeUrl, HOME);
  assert.equal(typeof params.bundle.site.sel.article, 'string');
  assert.match(params.bundle.inpage, /scan/);
  assert.deepEqual(params.cfg.llm, { provider: 'scripted', model: 'happy' });
  assert.equal(params.cfg.hide, 'script');
  for (const k of ['python', 'rpcTimeoutMs', 'homeUrl']) assert.ok(!(k in params.cfg), `cfg.${k} leaked to the sidecar`);
});

test('createDriver hands config.ts run.smoothScroll to the sidecar, like it does to Playwright', async () => {
  for (const smoothScroll of [false, true]) {
    const recordFile = path.join(TMP, `record-${++n}.jsonl`);
    const cfg = defaultConfig();
    cfg.run.smoothScroll = smoothScroll;
    cfg.browserUse = {
      ...cfg.browserUse,
      profileDir: path.join(TMP, 'profile-bu'),
      python: [process.execPath, FAKE, 'ok', '--record', recordFile],
      homeUrl: HOME,
    };
    const driver = await createDriver('browser-use', cfg);
    open.push(driver);
    await driver.open(noPrompt);
    const params = JSON.parse(fs.readFileSync(recordFile, 'utf8').trim().split('\n')[1]!).params;
    assert.equal(params.cfg.smoothScroll, smoothScroll);
  }
});

test('prompt: the login prompt reaches onPrompt, and open waits past rpcTimeoutMs for the human', async () => {
  const { driver } = setup('prompt', { args: ['--delay', '500'], cfg: { rpcTimeoutMs: 100 } });
  const prompts: string[] = [];
  const t0 = Date.now();
  assert.deepEqual(await driver.open({ onPrompt: (m) => prompts.push(m) }), { handle: 'me' });
  assert.ok(Date.now() - t0 >= 450, 'open answered too early');
  assert.deepEqual(prompts, ['Log in to X in the browser window (fake).']);
  assert.equal(await driver.focus('1000'), true);
});

test('prompt: close() while open still waits for the login stops the sidecar right away', async () => {
  const { driver, records, methods } = setup('prompt', { args: ['--delay', '60000'] });
  let prompted!: () => void;
  const promptSeen = new Promise<void>((r) => (prompted = r));
  const opening = assert.rejects(driver.open({ onPrompt: () => prompted() }), /closed/);
  await promptSeen;
  const t0 = Date.now();
  await driver.close(); // what a second Ctrl-C does
  assert.ok(Date.now() - t0 < 2000, 'close() waited behind the pending open');
  await opening;
  assert.deepEqual(methods(), ['open'], 'no close RPC should queue behind a pending open');
  assert.equal(alive(records()[0].pid), false);
});

test('garbage: non-protocol stdout lines are printed as [sidecar] ... and ignored', async (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const { driver } = setup('garbage');
  assert.deepEqual(await driver.open(noPrompt), { handle: 'me' });
  assert.equal((await driver.readVisiblePosts()).length, 2);
  assert.equal((await driver.markNotInterested('1000')).ok, true);

  const lines = printed.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(lines.includes('[sidecar] DEBUG [some_library] printed to stdout by mistake'), lines.join('\n'));
  assert.ok(lines.includes('[sidecar] {"hello": "not a protocol message"}'), lines.join('\n'));
  assert.ok(lines.every((l) => l.startsWith('[sidecar] ') && l.trim() !== '[sidecar]'), 'blank lines are dropped');
});

test('error: an {error} answer rejects that call only; the sidecar stays usable', async () => {
  const { driver, methods } = setup('error');
  await assert.rejects(driver.open(noPrompt), /open failed: fake open failed/);
  await assert.rejects(driver.readVisiblePosts(), /fake readVisiblePosts failed/);
  await assert.rejects(driver.markNotInterested('1000'), /fake markNotInterested failed/);
  await driver.close(); // its close RPC errors too; close() still shuts it down
  assert.deepEqual(methods(), ['open', 'readVisiblePosts', 'markNotInterested', 'close']);
});

test('hang: markNotInterested past rpcTimeoutMs rejects, kills the sidecar, later calls fail fast', async () => {
  const { driver, records } = setup('hang', { cfg: { rpcTimeoutMs: 300 } });
  await driver.open(noPrompt);
  const { pid } = records()[0];
  await assert.rejects(driver.markNotInterested('1000'), /did not answer "markNotInterested" within 300 ms/);
  await waitFor(() => !alive(pid), 3000);

  const t0 = Date.now();
  await assert.rejects(driver.readVisiblePosts(), /did not answer "markNotInterested"/);
  await assert.rejects(driver.focus('1000'), /did not answer "markNotInterested"/);
  assert.ok(Date.now() - t0 < 200, 'calls after the timeout should reject at once');
  await driver.close();
});

test('hang: close() kills a sidecar that ignores stdin EOF', async () => {
  const { driver, records, methods } = setup('hang');
  await driver.open(noPrompt);
  const { pid } = records()[0];
  const t0 = Date.now();
  await driver.close(); // close RPC answered, stdin ended, ~3 s grace, then SIGTERM to the group
  const took = Date.now() - t0;
  assert.ok(took >= 2500 && took < 6000, `close() took ${took} ms`);
  assert.deepEqual(methods(), ['open', 'close']);
  await waitFor(() => !alive(pid), 2000);
});

test('crash: the sidecar exiting rejects the pending call with a pointer to setup:bu', async () => {
  const { driver } = setup('crash');
  await assert.rejects(driver.open(noPrompt), /exited \(code 3\).*npm run setup:bu/);
  const t0 = Date.now();
  await assert.rejects(driver.readVisiblePosts(), /exited \(code 3\)/);
  assert.ok(Date.now() - t0 < 200);
  await driver.close();
});

test('crash: close() also stops what the dead sidecar left in its process group (its Chrome)', async () => {
  const { driver, records } = setup('crash', { args: ['--grandchild'] });
  await assert.rejects(driver.open(noPrompt), /exited \(code 3\)/);
  const { pid, grandchild } = records()[0];
  assert.ok(grandchild && alive(grandchild), 'the stand-in Chrome should outlive the crashed sidecar');
  assert.equal(alive(pid), false);
  await driver.close();
  await waitFor(() => !alive(grandchild), 3000);
});

test('spawn error: a missing python command points at setup:bu', async () => {
  const { driver } = setup('ok', { cfg: { python: [path.join(TMP, 'no-such-uv'), 'run'] } });
  await assert.rejects(driver.open(noPrompt), /Could not start the browser-use sidecar.*ENOENT.*npm run setup:bu/);
  await driver.close();
});

test('a profileDir containing "chrome" is refused before anything is spawned', async () => {
  const { driver, recordFile } = setup('ok', { cfg: { profileDir: path.join(TMP, 'Google/Chrome/Default') } });
  await assert.rejects(driver.open(noPrompt), /must not contain "chrome"/);
  assert.equal(fs.existsSync(recordFile), false, 'the sidecar was spawned anyway');
});

test('before open: calls reject, close() is a no-op', async () => {
  const { driver, recordFile } = setup('ok');
  await assert.rejects(driver.readVisiblePosts(), /open\(\) first/);
  await driver.close();
  assert.equal(fs.existsSync(recordFile), false);
});

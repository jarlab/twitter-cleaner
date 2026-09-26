// The real CLI (src/index.ts) started the way people start it, through `npm run start:bu`, with a fake
// `uv` on PATH that runs test/fixtures/fake-sidecar.mjs in "prompt" mode (open waits like a manual login).
// No Python, no browser, no network: --limit 0 means nothing is ever classified.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const BOT = path.resolve(import.meta.dirname, '..');
const FAKE = path.join(import.meta.dirname, 'fixtures/fake-sidecar.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-'));
const PROMPT = 'Log in to X in the browser window (fake).';
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Run = { child: ChildProcess; out: () => string; exit: Promise<number | null> };

// `npm run start:bu -- --hide script --limit 0`, in its own process group (like a terminal's foreground job).
function start(delayMs: number): Run {
  const bin = fs.mkdtempSync(path.join(TMP, 'bin-'));
  const uv = path.join(bin, 'uv');
  fs.writeFileSync(uv, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" prompt --delay ${delayMs}\n`, { mode: 0o755 });
  const npm = process.env.npm_execpath;
  const [cmd, pre] = npm && npm.endsWith('.js') ? [process.execPath, [npm]] : ['npm', []];
  const child = spawn(
    cmd,
    [...pre, 'run', 'start:bu', '--', '--hide', 'script', '--limit', '0', '--log', path.join(bin, 'decisions.jsonl')],
    {
      cwd: BOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TYPESAFE_API_KEY: 'dummy-never-used' },
    },
  );
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exit = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  return { child, out: () => out, exit };
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 25))) {
    if (Date.now() > end) assert.fail(`${what}: not within ${ms} ms`);
  }
}

// What the terminal does on Ctrl-C: SIGINT to every process in the foreground group (npm, tsx, node).
const ctrlC = (r: Run) => process.kill(-r.child.pid!, 'SIGINT');

describe('CLI Ctrl-C under npm run', { timeout: 60_000 }, () => {
  it('one Ctrl-C only asks to stop (npm re-sends SIGINT to its child; that echo is not a second press)', async () => {
    const r = start(2500);
    try {
      await waitFor(() => r.out().includes(PROMPT), 20_000, 'login prompt');
      ctrlC(r);
      assert.equal(await r.exit, 0, r.out());
      assert.equal(r.out().split('Stopping after the current post').length - 1, 1, r.out());
      assert.match(r.out(), /Classified 0, marked 0 as not interested/);
      assert.doesNotMatch(r.out(), /driver is closed/);
    } finally {
      if (r.child.exitCode === null) process.kill(-r.child.pid!, 'SIGKILL');
    }
  });

  it('a second Ctrl-C a moment later closes the driver and exits 130', async () => {
    const r = start(60_000);
    try {
      await waitFor(() => r.out().includes(PROMPT), 20_000, 'login prompt');
      ctrlC(r);
      await new Promise((res) => setTimeout(res, 1500));
      assert.equal(r.child.exitCode, null, `the first Ctrl-C alone ended the run:\n${r.out()}`);
      const t0 = Date.now();
      ctrlC(r);
      assert.equal(await r.exit, 130, r.out());
      assert.ok(Date.now() - t0 < 5000, 'quitting took too long');
    } finally {
      if (r.child.exitCode === null) process.kill(-r.child.pid!, 'SIGKILL');
    }
  });
});

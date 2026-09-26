// Browser Use driver, Node side: a thin proxy. browser-use is a Python library, so the real work
// happens in bot/browser-use/server.py. We spawn it and talk JSON lines over its stdin/stdout:
//   Node -> Python:  {"id": 1, "method": "open", "params": {...}}
//   Python -> Node:  {"id": 1, "result": ...}  or  {"id": 1, "error": {"message": "..."}}
//                    {"event": "prompt", "message": "..."}   (unsolicited: "please log in")
// Python's logs go to stderr, which is passed straight through to this terminal.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Config } from '../config.js';
import { siteBundle } from '../site/index.js';
import type { DriverStats, FeedDriver, HideResult, Post, RpcRequest, SiteBundle } from './types.js';

/** config.ts's `browserUse` section: the sidecar's BrowserUseConfig plus python, rpcTimeoutMs, homeUrl. */
export type BrowserUseDriverConfig = Config['browserUse'];

type Method = RpcRequest['method'];
type ParamsOf<M extends Method> = Extract<RpcRequest, { method: M }>['params'];
type Pending = { id: number; method: Method; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout };

const TIMEOUT_MS = 30_000; // every call except open (none: a human may be logging in) and markNotInterested
const CLOSE_RPC_MS = 15_000;
const EXIT_WAIT_MS = 3_000;
const SETUP_HINT = 'run "npm run setup:bu" in bot/ first';

export default function createBrowserUseDriver(
  cfg: BrowserUseDriverConfig,
  bundle: SiteBundle = siteBundle(cfg.homeUrl ? { homeUrl: cfg.homeUrl } : {}),
): FeedDriver {
  const { python, rpcTimeoutMs, homeUrl: _homeUrl, ...sidecarCfg } = cfg; // the sidecar gets BrowserUseConfig only
  let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  let exited: Promise<void> = Promise.resolve();
  let dead: Error | null = null; // once set, every call rejects with it (fast)
  let inFlight: Pending | null = null;
  let queue: Promise<unknown> = Promise.resolve(); // one request in flight at a time
  let nextId = 1;
  let onPrompt: (msg: string) => void = () => {};
  let closing: Promise<void> | null = null;

  // The sidecar is unusable from now on: remember why and reject whatever is waiting.
  function fail(err: Error): void {
    dead ??= err;
    if (inFlight) {
      clearTimeout(inFlight.timer);
      inFlight.reject(dead);
      inFlight = null;
    }
  }

  // Negative pid = the whole process group (detached: true made one): uv, Python and its Chrome.
  // The group outlives uv when the sidecar crashes (its Chrome keeps running), so this is also used
  // after uv has exited. Returns false once nobody is left in the group (ESRCH). Signal 0 only checks.
  function killGroup(signal: NodeJS.Signals | 0): boolean {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  async function groupGoneWithin(ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; killGroup(0); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) return false;
    }
    return true;
  }

  function onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: unknown; result?: unknown; error?: { message?: string }; event?: unknown; message?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') msg = parsed;
    } catch {
      // not JSON: a stray print from some library
    }
    if (msg.event === 'prompt') return onPrompt(String(msg.message));
    if (inFlight && msg.id === inFlight.id && ('result' in msg || 'error' in msg)) {
      const p = inFlight;
      inFlight = null;
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`browser-use sidecar: ${p.method} failed: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    console.error(`[sidecar] ${line}`);
  }

  function request<M extends Method>(method: M, params: ParamsOf<M>, timeoutMs: number): Promise<unknown> {
    const send = () =>
      new Promise<unknown>((resolve, reject) => {
        if (dead) return reject(dead);
        if (!child) return reject(new Error('browser-use driver: call open() first'));
        const p: Pending = { id: nextId++, method, resolve, reject };
        if (timeoutMs > 0) {
          p.timer = setTimeout(() => {
            fail(new Error(`browser-use sidecar did not answer "${method}" within ${timeoutMs} ms; stopped it.`));
            killGroup('SIGTERM');
          }, timeoutMs);
        }
        inFlight = p;
        child.stdin.write(JSON.stringify({ id: p.id, method, params }) + '\n');
      });
    const result = queue.then(send);
    queue = result.catch(() => {});
    return result;
  }

  // Resolves true if the child is gone within `ms`.
  function exitWithin(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      exited.then(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  return {
    name: 'browser-use',

    async open(o) {
      if (/chrome/i.test(cfg.profileDir)) {
        // browser-use treats such a path as a real Chrome profile: it copies it to a temp dir and the
        // login you do by hand is thrown away on exit.
        throw new Error(`browserUse.profileDir must not contain "chrome": ${cfg.profileDir}`);
      }
      if (child) throw new Error('browser-use driver: open() was already called');
      const [cmd, ...args] = python;
      if (!cmd) throw new Error('browserUse.python is empty');
      onPrompt = o.onPrompt;

      // PYTHON_DOTENV_DISABLED: browser-use calls load_dotenv() when imported, which walks up from its
      // .venv to the repo's .env and would put TYPESAFE_API_KEY right back. We loaded .env already.
      const env: NodeJS.ProcessEnv = { ...process.env, ANONYMIZED_TELEMETRY: 'false', PYTHON_DOTENV_DISABLED: '1' };
      delete env.TYPESAFE_API_KEY; // the classifier key never leaves this process
      // detached: its own process group, so a Ctrl-C in the terminal reaches only us (we own shutdown).
      const c = spawn(cmd, args, { detached: true, stdio: ['pipe', 'pipe', 'inherit'], env });
      child = c;
      c.on('error', (err) =>
        fail(new Error(`Could not start the browser-use sidecar (${python.join(' ')}): ${err.message}. Did you ${SETUP_HINT}?`)),
      );
      exited = new Promise((resolve) =>
        c.on('close', (code, signal) => {
          fail(
            new Error(
              `The browser-use sidecar exited (${signal ?? `code ${code}`}); its output is above. If it never started, ${SETUP_HINT}.`,
            ),
          );
          resolve();
        }),
      );
      c.stdin.on('error', () => {}); // EPIPE once it has died; the 'close' handler reports that
      readline.createInterface({ input: c.stdout }).on('line', onLine);

      const r = (await request('open', { bundle, cfg: sidecarCfg }, 0)) as { handle?: string | null } | null;
      return { handle: r?.handle ?? null };
    },

    readVisiblePosts: async () => (await request('readVisiblePosts', {}, TIMEOUT_MS)) as Post[],
    focus: async (id) => (await request('focus', { id }, TIMEOUT_MS)) as boolean,
    scroll: async () => {
      await request('scroll', {}, TIMEOUT_MS);
    },
    markNotInterested: async (id, o = {}) =>
      (await request('markNotInterested', { id, commit: o.commit ?? true }, rpcTimeoutMs)) as HideResult,
    stats: async () => (await request('stats', {}, TIMEOUT_MS)) as DriverStats | null,

    close() {
      closing ??= (async () => {
        if (!child) return;
        // Ask nicely, unless a call is still waiting (e.g. open while you log in): the sidecar answers
        // one request at a time, so a close RPC would only queue behind it.
        if (!dead && !inFlight) await request('close', {}, CLOSE_RPC_MS).catch(() => {});
        fail(new Error('browser-use driver is closed'));
        child.stdin.end(); // EOF: server.py closes the browser and exits
        await exitWithin(EXIT_WAIT_MS);
        // Then stop whatever is left of the group: a sidecar that ignored EOF, or the Chrome of one that
        // crashed. After a clean exit the group is empty and nothing is sent.
        if (killGroup('SIGTERM') && !(await groupGoneWithin(2_000))) killGroup('SIGKILL');
      })();
      return closing;
    },
  };
}

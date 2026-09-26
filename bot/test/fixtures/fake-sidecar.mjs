// A stand-in for bot/browser-use/server.py that speaks the same JSON-lines protocol, so the Node proxy
// (src/drivers/browser-use.ts) can be tested without Python or a browser.
//
//   node fake-sidecar.mjs <mode> [--record FILE] [--delay MS] [--grandchild]
//
// Modes:
//   ok       answers every method with plausible results; exits on stdin EOF
//   prompt   like ok, but open first sends a "prompt" event and answers only after --delay ms
//   garbage  like ok, but mixes non-protocol lines into stdout and splits answers across writes
//   error    answers every request with {error}; exits on stdin EOF
//   hang     answers open and close only; ignores stdin EOF (so the proxy has to kill it)
//   crash    exits with code 3 on the first request, without answering
//
// --record appends JSON lines to FILE: first {pid, grandchild, env}, then {method, params, overlapped} per
// request (overlapped = it arrived while the previous one was still unanswered).
// --grandchild starts a long-lived child in our process group, like the Chrome browser-use launches;
// nothing here ever stops it, so it outlives a crash.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    record: { type: 'string' },
    delay: { type: 'string', default: '300' },
    grandchild: { type: 'boolean', default: false },
  },
});
const mode = positionals[0] ?? 'ok';
const delay = Number(values.delay);

const record = (obj) => values.record && fs.appendFileSync(values.record, JSON.stringify(obj) + '\n');
const grandchild = values.grandchild
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid
  : null;
record({
  pid: process.pid,
  grandchild,
  env: {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ?? null,
    ANONYMIZED_TELEMETRY: process.env.ANONYMIZED_TELEMETRY ?? null,
    PYTHON_DOTENV_DISABLED: process.env.PYTHON_DOTENV_DISABLED ?? null,
  },
});

const POSTS = [
  { id: '1000', author: 'alice', text: 'first post', quoted: null },
  { id: '1001', author: 'bob', text: 'second post', quoted: 'the quoted one' },
];
const LABEL = 'Not interested in this post';

function answer(method, params) {
  switch (method) {
    case 'open':
      return { handle: 'me' };
    case 'readVisiblePosts':
      return POSTS;
    case 'focus':
      return POSTS.some((p) => p.id === params.id);
    case 'markNotInterested':
      if (!POSTS.some((p) => p.id === params.id)) return { ok: false, via: null, reason: 'not_found' };
      return params.commit ? { ok: true, via: 'script', label: LABEL } : { ok: true, via: 'script', rehearsed: true, label: LABEL };
    case 'stats':
      return { agentRuns: 0, costUsd: 0 };
    default: // scroll, close
      return null;
  }
}

function send(msg) {
  const line = JSON.stringify(msg) + '\n';
  if (mode !== 'garbage') return void process.stdout.write(line);
  process.stdout.write('DEBUG [some_library] printed to stdout by mistake\n');
  process.stdout.write('\n');
  process.stdout.write('{"hello": "not a protocol message"}\n');
  // Split the real answer across two writes: the proxy must buffer until the newline.
  const half = Math.floor(line.length / 2);
  process.stdout.write(line.slice(0, half));
  setTimeout(() => process.stdout.write(line.slice(half)), 20);
}

let busy = false; // a request is waiting for its answer

function handle({ id, method, params }) {
  record({ method, params, overlapped: busy });
  if (mode === 'crash') {
    process.stderr.write('fake-sidecar: crashing on purpose\n');
    process.exit(3);
  }
  if (mode === 'error') return send({ id, error: { message: `fake ${method} failed` } });
  if (mode === 'hang' && method !== 'open' && method !== 'close') return; // never answers

  busy = true;
  const reply = () => {
    busy = false;
    send({ id, result: answer(method, params) });
  };
  if (mode === 'prompt' && method === 'open') {
    send({ event: 'prompt', message: 'Log in to X in the browser window (fake).' });
    setTimeout(reply, delay);
  } else {
    setTimeout(reply, 10); // a little latency, so overlapping requests would be noticed
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => line.trim() && handle(JSON.parse(line)));

if (mode === 'hang') setInterval(() => {}, 1000); // stay alive after stdin EOF
else process.stdin.on('end', () => process.exit(0));

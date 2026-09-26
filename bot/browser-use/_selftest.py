"""End-to-end self-test of the sidecar, the way Node drives it, for $0 (scripted LLM, headless, temp profiles).

    uv run --project bot/browser-use python bot/browser-use/_selftest.py      (from the repo root, or anywhere)

Serves bot/test/fixtures/fake_x.html over http with a small probe script (it reports window.__clicks etc. back
to this server and clicks "Log in" when told to, playing the human), spawns server.py exactly like Node does
(uv run --quiet --project <bot/browser-use> python <server.py>), and speaks the JSON-lines protocol.
The sidecar's stderr goes to a log file (path printed at the end).
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
BOT = HERE.parent
FIXTURE = (BOT / 'test/fixtures/fake_x.html').read_text()
SITE = json.loads((BOT / 'src/site/x.json').read_text())
INPAGE = (BOT / 'src/site/x.inpage.js').read_text()
PYTHON = ['uv', 'run', '--quiet', '--project', str(HERE), 'python', str(HERE / 'server.py')]
NI = 'Not interested in this post'

PROBE = """<script>
(() => {
  const session = new URLSearchParams(location.search).get('session');
  let last = '';
  setInterval(async () => {
    const f = document.querySelector('[data-tc-focus]');
    const s = JSON.stringify({ clicks: window.__clicks, hidden: window.__hidden, scrollY: Math.round(scrollY),
      menuOpen: !!document.querySelector('[role="menu"]'), focusTop: f ? Math.round(f.getBoundingClientRect().top) : null });
    if (s !== last) { last = s; fetch('/__state?session=' + session, { method: 'POST', body: s }).catch(() => { last = ''; }); }
    const login = document.getElementById('login');
    if (login && (await fetch('/__login?session=' + session).then((r) => r.text(), () => '')) === 'yes') login.click();
  }, 100);
})();
</script>"""

STATES: dict[str, dict] = {}
LOGIN_OK: set[str] = set()


class Handler(BaseHTTPRequestHandler):
	def log_message(self, *a):
		pass

	def _reply(self, body: bytes, ctype='text/plain'):
		self.send_response(200)
		self.send_header('content-type', ctype)
		self.send_header('content-length', str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def do_GET(self):
		u = urlparse(self.path)
		session = parse_qs(u.query).get('session', [''])[0]
		if u.path == '/__login':
			return self._reply(b'yes' if session in LOGIN_OK else b'no')
		if u.path == '/api/tags':  # a stand-in for Ollama's model list
			return self._reply(json.dumps({'models': [{'name': 'llama3.2:latest', 'model': 'llama3.2:latest'}]}).encode())
		if u.path == '/home':
			return self._reply(FIXTURE.replace('</body>', PROBE + '\n</body>').encode(), 'text/html; charset=utf-8')
		self.send_response(404)
		self.end_headers()

	def do_POST(self):
		u = urlparse(self.path)
		session = parse_qs(u.query).get('session', [''])[0]
		body = self.rfile.read(int(self.headers.get('content-length', 0)))
		STATES[session] = json.loads(body)
		self._reply(b'')


class Sidecar:
	"""A minimal Node-proxy stand-in: one request in flight, events on the side."""

	def __init__(self, log):
		self.log = log
		self.prompts: list[str] = []
		self.proc = None
		self.pending: dict[int, asyncio.Future] = {}
		self.next_id = 1

	async def start(self):
		env = {k: v for k, v in os.environ.items() if k != 'TYPESAFE_API_KEY'}
		env['ANONYMIZED_TELEMETRY'] = 'false'
		self.proc = await asyncio.create_subprocess_exec(
			*PYTHON, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=self.log, env=env,
			start_new_session=True, limit=1 << 22,
		)
		self.reader = asyncio.create_task(self._read())

	async def _read(self):
		async for raw in self.proc.stdout:
			line = raw.decode().strip()
			try:
				msg = json.loads(line)
			except ValueError:
				print(f'  !! non-JSON stdout line: {line[:100]}')
				continue
			if msg.get('event') == 'prompt':
				self.prompts.append(msg['message'])
			elif msg.get('id') in self.pending:
				self.pending.pop(msg['id']).set_result(msg)
		for f in self.pending.values():
			if not f.done():
				f.set_exception(RuntimeError('sidecar exited'))

	async def call(self, method, params=None, timeout=60):
		i = self.next_id
		self.next_id += 1
		fut = asyncio.get_running_loop().create_future()
		self.pending[i] = fut
		self.proc.stdin.write((json.dumps({'id': i, 'method': method, 'params': params or {}}) + '\n').encode())
		await self.proc.stdin.drain()
		msg = await asyncio.wait_for(fut, timeout)
		if 'error' in msg:
			raise RuntimeError(msg['error']['message'])
		return msg['result']

	async def stop(self):
		self.proc.stdin.close()  # EOF: the sidecar closes its browser and exits
		try:
			await asyncio.wait_for(self.proc.wait(), 15)
		except TimeoutError:
			os.killpg(self.proc.pid, 15)
			raise RuntimeError('sidecar did not exit on stdin EOF')


RESULTS: list[tuple[bool, str]] = []


def check(ok: bool, what: str, got=None):
	RESULTS.append((bool(ok), what))
	print(f'  {"PASS" if ok else "FAIL"}  {what}' + ('' if ok else f'   got: {json.dumps(got)[:300]}'))


async def state(session: str, settle=0.4) -> dict:
	await asyncio.sleep(settle)  # the probe reports every 100 ms
	return STATES.get(session, {})


SESSION = 0


def new_session(origin: str, query: str = '') -> tuple[str, dict]:
	"""A fresh probe session id and the site bundle pointing at it."""
	global SESSION
	SESSION += 1
	sid = str(SESSION)
	home = f'{origin}/home?session={sid}' + (f'&{query}' if query else '')
	return sid, {'site': {**SITE, 'homeUrl': home}, 'inpage': INPAGE}


PROFILES: list[str] = []


def make_cfg(hide='script', model='happy', **over) -> dict:
	PROFILES.append(tempfile.mkdtemp(prefix='tc-selftest-bu-'))
	return {
		'profileDir': PROFILES[-1],  # temp profile per session
		'headless': True,
		'window': {'width': 1200, 'height': 900},
		'settleMs': 300,
		'menuTimeoutMs': 3000,
		'hide': hide,
		'llm': {'provider': 'scripted', 'model': model},
		'maxAgentRuns': 20,
		'maxUsd': 2,
		'maxStepsPerHide': 4,
		'agentTimeoutS': 90,
		**over,
	}


async def session(origin, log, query='', **cfg_over):
	sid, bundle = new_session(origin, query)
	sc = Sidecar(log)
	await sc.start()
	LOGIN_OK.add(sid)
	t = time.monotonic()
	opened = await sc.call('open', {'bundle': bundle, 'cfg': make_cfg(**cfg_over)}, 120)
	print(f'  (open took {time.monotonic() - t:.1f}s)')
	return sc, sid, opened


def factory_checks():
	"""make_llm for every provider (construction only: no network), with dummy keys."""
	import llm

	keys = {v: 'dummy' for v in llm.KEY_ENV.values() if v}
	saved = {k: os.environ.pop(k, None) for k in [*keys, 'VERCEL_OIDC_TOKEN', 'OLLAMA_HOST']}
	try:
		try:
			llm.make_llm({'provider': 'openrouter', 'model': 'meta-llama/llama-3.3-70b-instruct:free'})
			check(False, 'missing OPENROUTER_API_KEY -> error')
		except RuntimeError as e:
			check('OPENROUTER_API_KEY' in str(e), 'missing OPENROUTER_API_KEY -> clear error', str(e))
		os.environ['VERCEL_OIDC_TOKEN'] = 'dummy'
		check(llm.make_llm({'provider': 'vercel', 'model': 'openai/gpt-oss-120b'}).provider == 'vercel', 'vercel accepts VERCEL_OIDC_TOKEN')
		os.environ.update(keys)
		cases = {
			'ollama': 'qwen3:8b', 'openrouter': 'meta-llama/llama-3.3-70b-instruct:free', 'vercel': 'openai/gpt-oss-120b',
			'groq': 'llama-3.3-70b-versatile', 'cerebras': 'gpt-oss-120b', 'openai': 'gpt-4.1-mini',
			'anthropic': 'claude-haiku-4-5', 'google': 'gemini-2.5-flash', 'browser-use': 'bu-2-0', 'scripted': 'happy',
		}
		for provider, model in cases.items():
			try:
				m = llm.make_llm({'provider': provider, 'model': model, 'temperature': 0})
				check(m.model == model, f'make_llm {provider}:{model} -> {type(m).__name__} (provider {m.provider})')
			except Exception as e:
				check(False, f'make_llm {provider}:{model}', f'{type(e).__name__}: {e}')
		m = llm.make_llm({'provider': 'openai-compatible', 'model': 'local', 'baseUrl': 'http://localhost:1234/v1'})
		check(str(m.base_url).startswith('http://localhost:1234') and m.api_key == 'not-needed', 'openai-compatible: baseUrl + dummy key')
		try:
			llm.make_llm({'provider': 'openai-compatible', 'model': 'local'})
			check(False, 'openai-compatible without baseUrl -> error')
		except RuntimeError as e:
			check('baseUrl' in str(e), 'openai-compatible without baseUrl -> clear error', str(e))
		# Read like the ollama client reads it: no port means 11434, even with the host alone (Ollama's own FAQ uses 0.0.0.0).
		for raw, want in [('127.0.0.1:11999', 'http://127.0.0.1:11999'), ('0.0.0.0', 'http://0.0.0.0:11434'),
						  ('localhost', 'http://localhost:11434'), (':11500', 'http://127.0.0.1:11500')]:
			os.environ['OLLAMA_HOST'] = raw
			got = llm.ollama_host({'provider': 'ollama', 'model': 'x'})
			check(got == want, f'OLLAMA_HOST {raw!r} -> {want}', got)
		os.environ.pop('OLLAMA_HOST')
		check(llm.ollama_host({'provider': 'ollama', 'model': 'x'}) == 'http://127.0.0.1:11434', 'no OLLAMA_HOST -> 127.0.0.1:11434')
		check(llm.describe({'provider': 'ollama', 'model': 'qwen3:8b'}) == 'ollama:qwen3:8b', 'describe -> provider:model')
	finally:
		for k in [*keys, 'VERCEL_OIDC_TOKEN', 'OLLAMA_HOST']:
			os.environ.pop(k, None)
		os.environ.update({k: v for k, v in saved.items() if v is not None})


async def cost_checks():
	"""hide_agent._cost: a local model costs only the llm.prices estimate, whatever browser-use's price table says."""
	import hide_agent

	class Usage:  # 1M in + 100k out; $0.1625 is what browser-use charges "qwen/qwen3-8b" (OpenRouter's rate)
		total_prompt_tokens, total_completion_tokens, total_cost = 1_000_000, 100_000, 0.1625

	class Service:
		async def get_usage_summary(self):
			return Usage()

	class FakeAgent:
		token_cost_service = Service()

	lm = {'provider': 'openai-compatible', 'model': 'qwen/qwen3-8b', 'baseUrl': 'http://localhost:1234/v1'}
	got = await hide_agent._cost(FakeAgent(), lm)
	check(got == 0, 'openai-compatible "qwen/qwen3-8b" (LM Studio) -> $0, not OpenRouter rates', got)
	got = await hide_agent._cost(FakeAgent(), {**lm, 'prices': {'in': 1, 'out': 2}})
	check(abs(got - 1.2) < 1e-9, 'openai-compatible with llm.prices -> that estimate', got)
	got = await hide_agent._cost(FakeAgent(), {'provider': 'openrouter', 'model': 'qwen/qwen3-8b'})
	check(got == 0.1625, "openrouter -> browser-use's price", got)


async def main():
	httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
	threading.Thread(target=httpd.serve_forever, daemon=True).start()
	origin = f'http://127.0.0.1:{httpd.server_address[1]}'
	log_path = Path(tempfile.gettempdir()) / 'tc-selftest-sidecar.log'
	log = open(log_path, 'w')
	t0 = time.monotonic()

	print('\n[0] LLM factory and cost (no network)')
	factory_checks()
	await cost_checks()

	print('\n[1] hide script, plain feed')
	sc, sid, opened = await session(origin, log)
	check(opened == {'handle': 'me'}, 'open -> handle "me"', opened)
	posts = await sc.call('readVisiblePosts')
	check([p['id'] for p in posts] == [str(1000 + i) for i in range(6)], 'readVisiblePosts: 6 posts in feed order', posts)
	check(all(set(p) == {'id', 'author', 'text', 'quoted'} for p in posts), 'post shape {id, author, text, quoted}', posts[0])
	check(posts[2]['quoted'] == 'Quoted text from zed' and posts[5]['text'] == '', 'quoted text / media-only post', posts[2:6])
	check(await sc.call('focus', {'id': '1001'}) is True, 'focus(1001) -> true')
	s = await state(sid)
	check(s.get('scrollY', 0) > 0 and 53 <= (s.get('focusTop') or -1) <= 70, 'focus scrolled the post under the header', s)
	check(await sc.call('focus', {'id': '31337'}) is False, 'focus(unknown) -> false')
	y0 = (await state(sid))['scrollY']
	await sc.call('scroll')
	y1 = (await state(sid))['scrollY']
	check(y1 > y0, f'scroll moved the page ({y0} -> {y1})', [y0, y1])
	r = await sc.call('markNotInterested', {'id': '1000', 'commit': True})
	check(r.get('ok') and r.get('via') == 'script' and r.get('label') == NI, 'hide 1000 by script -> ok', r)
	s = await state(sid)
	check(s['clicks'] == [{'post': '1000', 'label': NI}] and not s['menuOpen'], '__clicks has exactly post 1000', s)
	r = await sc.call('markNotInterested', {'id': '424242', 'commit': True})
	check(r.get('reason') == 'not_found', 'bogus id -> not_found', r)
	r = await sc.call('markNotInterested', {'id': '1003', 'commit': True})
	check(r.get('reason') == 'no_menu_item' and not (await state(sid))['menuOpen'], 'ad -> no_menu_item, menu closed', r)
	r = await sc.call('markNotInterested', {'id': '1001', 'commit': False})
	s = await state(sid)
	check(r.get('ok') and r.get('rehearsed') and r.get('label') == NI, 'commit:false -> rehearsed', r)
	check(len(s['clicks']) == 1 and '1001' not in s['hidden'] and not s['menuOpen'], 'rehearsal clicked nothing, no menu open', s)
	check(await sc.call('stats') == {'agentRuns': 0, 'costUsd': 0}, 'stats (script) -> 0 runs, $0')
	check(await sc.call('close') is None and await sc.call('close') is None, 'close twice -> ok')
	await sc.stop()

	print('\n[2] ?shuffle=1 (every node replaced, in reverse order, 800 ms after load)')
	sc, sid, _ = await session(origin, log, 'shuffle=1')
	a = await sc.call('markNotInterested', {'id': '1001', 'commit': True})  # races the re-render
	await asyncio.sleep(1.0)
	b = await sc.call('markNotInterested', {'id': '1000', 'commit': True})  # after it
	s = await state(sid)
	check(a.get('ok') and b.get('ok'), 'both hides ok (during and after the re-render)', [a, b])
	check(s['clicks'] == [{'post': '1001', 'label': NI}, {'post': '1000', 'label': NI}] and s['hidden'] == ['1001', '1000'],
		  'the RIGHT posts were hidden, by id', s)
	await sc.stop()

	print('\n[3] ?logged_out=1 (a human logs in)')
	sid, bundle = new_session(origin, 'logged_out=1')
	sc = Sidecar(log)
	await sc.start()
	opening = asyncio.create_task(sc.call('open', {'bundle': bundle, 'cfg': make_cfg()}, 120))
	for _ in range(200):
		if sc.prompts:
			break
		await asyncio.sleep(0.1)
	check(sc.prompts == [SITE['text']['loginPrompt']], 'prompt event sent once', sc.prompts)
	await asyncio.sleep(2)
	check(not opening.done(), 'open keeps waiting while logged out')
	LOGIN_OK.add(sid)
	opened = await opening
	check(opened == {'handle': 'me'}, 'open resolves after the "human" logs in', opened)
	await sc.stop()

	print('\n[3b] close while open waits for a login (Ctrl-C during login)')
	sid, bundle = new_session(origin, 'logged_out=1')
	sc = Sidecar(log)
	await sc.start()
	opening = asyncio.create_task(sc.call('open', {'bundle': bundle, 'cfg': make_cfg()}, 120))
	while not sc.prompts:
		await asyncio.sleep(0.1)
	t = time.monotonic()
	check(await sc.call('close', timeout=15) is None, f'close answered while open was pending ({time.monotonic() - t:.1f}s)')
	opening.cancel()
	await sc.stop()
	check(sc.proc.returncode == 0, 'sidecar exited cleanly on stdin EOF', sc.proc.returncode)

	print('\n[4] hide agent + scripted happy')
	sc, sid, _ = await session(origin, log, hide='agent', model='happy')
	t = time.monotonic()
	r = await sc.call('markNotInterested', {'id': '1001', 'commit': True}, 150)
	print(f'  (agent run took {time.monotonic() - t:.1f}s)')
	s = await state(sid)
	check(r.get('ok') and r.get('via') == 'agent' and r.get('label') == NI, 'agent hides 1001 -> ok via agent', r)
	check(s['clicks'] == [{'post': '1001', 'label': NI}] and not s['menuOpen'], '__clicks has exactly post 1001', s)
	r = await sc.call('markNotInterested', {'id': '1002', 'commit': False}, 150)
	s = await state(sid)
	check(r.get('ok') and r.get('rehearsed') and len(s['clicks']) == 1 and not s['menuOpen'], 'agent rehearsal clicks nothing', [r, s])
	st = await sc.call('stats')
	check(st == {'agentRuns': 2, 'costUsd': 0}, 'stats -> 2 agent runs, $0', st)
	r = await sc.call('readVisiblePosts')
	check(len(r) >= 4, 'deterministic path still works after agent runs', len(r))
	await sc.stop()

	print('\n[5] ?trap=1 + hide agent + scripted trap (menu has only Mute/Block/Report)')
	sc, sid, _ = await session(origin, log, 'trap=1', hide='agent', model='trap')
	r = await sc.call('markNotInterested', {'id': '1000', 'commit': True}, 150)
	s = await state(sid)
	check(r.get('reason') == 'no_menu_item' and r.get('via') == 'agent', 'trap -> no_menu_item', r)
	check(s['clicks'] == [] and not s['menuOpen'], 'ZERO menu clicks (forbidden label refused)', s)
	check((r.get('hint') or {}).get('refused') == ['Block @alice'], 'hint records the refused label', r.get('hint'))
	await sc.stop()

	print('\n[6] ?drift=1 + hide auto + scripted happy (caret testid renamed)')
	sc, sid, _ = await session(origin, log, 'drift=1', hide='auto', model='happy')
	r = await sc.call('markNotInterested', {'id': '1000', 'commit': True}, 150)
	s = await state(sid)
	script = ((r.get('hint') or {}).get('script') or {}).get('reason')
	check(r.get('ok') and r.get('via') == 'agent' and script == 'caret_missing', 'script fails caret_missing, agent rescues', r)
	check(s['clicks'] == [{'post': '1000', 'label': NI}], '__clicks has exactly post 1000', s)
	check((await sc.call('stats'))['agentRuns'] == 1, 'stats -> 1 agent run')
	await sc.stop()

	print('\n[7] hide agent + scripted confused, then budget (maxAgentRuns=1)')
	sc, sid, _ = await session(origin, log, hide='agent', model='confused', maxAgentRuns=1)
	r = await sc.call('markNotInterested', {'id': '1000', 'commit': True}, 150)
	s = await state(sid)
	check(r.get('reason') == 'gave_up' and s['clicks'] == [] and not s['menuOpen'], 'confused -> gave_up, nothing clicked', [r, s])
	r = await sc.call('markNotInterested', {'id': '1001', 'commit': True}, 150)
	check(r.get('reason') == 'budget', 'second run -> budget', r)
	await sc.stop()

	print('\n[8] preflight: hide auto + Ollama not running -> fails before a browser opens')
	sid, bundle = new_session(origin)
	sc = Sidecar(log)
	await sc.start()
	cfg = make_cfg(hide='auto', llm={'provider': 'ollama', 'model': 'qwen3:8b', 'baseUrl': 'http://127.0.0.1:9'})
	try:
		await sc.call('open', {'bundle': bundle, 'cfg': cfg}, 30)
		check(False, 'open should fail')
	except RuntimeError as e:
		check('not reachable' in str(e) and 'ollama serve' in str(e), 'clear "Ollama is not reachable" error', str(e))
	cfg = make_cfg(hide='auto', llm={'provider': 'ollama', 'model': 'qwen3:8b', 'baseUrl': origin})
	try:
		await sc.call('open', {'bundle': bundle, 'cfg': cfg}, 30)
		check(False, 'open should fail')
	except RuntimeError as e:
		check('ollama pull qwen3:8b' in str(e), 'clear "ollama pull <model>" error when the model is missing', str(e))
	cfg = make_cfg(profileDir='/tmp/my-chrome-profile')
	try:
		await sc.call('open', {'bundle': bundle, 'cfg': cfg}, 30)
		check(False, 'chrome profile should be refused')
	except RuntimeError as e:
		check('chrome' in str(e), 'profileDir containing "chrome" refused', str(e))
	LOGIN_OK.add(sid)
	cfg = make_cfg(hide='auto', llm={'provider': 'ollama', 'model': 'llama3.2', 'baseUrl': origin})
	opened = await sc.call('open', {'bundle': bundle, 'cfg': cfg}, 60)
	r = await sc.call('markNotInterested', {'id': '1000', 'commit': True})
	check(opened == {'handle': 'me'} and r.get('ok') and r.get('via') == 'script', 'model pulled (llama3.2 = :latest) -> opens; auto uses the script', [opened, r])
	check((await sc.call('stats'))['agentRuns'] == 0, 'auto: no agent run when the script works')
	await sc.stop()

	httpd.shutdown()
	log.close()
	for d in PROFILES:
		shutil.rmtree(d, ignore_errors=True)
	failed = [w for ok, w in RESULTS if not ok]
	print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed in {time.monotonic() - t0:.0f}s. Sidecar log: {log_path}')
	return 1 if failed else 0


if __name__ == '__main__':
	sys.exit(asyncio.run(main()))

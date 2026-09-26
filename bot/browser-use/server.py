"""Browser Use sidecar for the twitter-cleaner bot (bot/src/drivers/browser-use.ts spawns it).

JSON lines over stdio: requests {id, method, params} arrive on stdin, responses {id, result} / {id, error: {message}}
and the unsolicited {event: 'prompt', message} go to stdout. Everything else (browser-use's logs) goes to stderr.

The deterministic path (reading, focusing, scrolling, hiding by script) uses browser-use's Actor API only: no LLM.
The LLM agent (hide_agent.py) runs only to operate one post's menu, and only when the hide mode allows it.
All X knowledge comes from the site bundle (bot/src/site/x.json + x.inpage.js) that Node sends with `open`.
"""

import os
import signal
import sys

# ---- stdout hygiene, before anything can print: keep a private copy of stdout for the protocol, then point fd 1
# at stderr so browser-use's logging (and any stray print) can never corrupt a JSON line.
PROTO = os.fdopen(os.dup(1), 'w', buffering=1, encoding='utf-8')
os.dup2(2, 1)
signal.signal(signal.SIGINT, signal.SIG_IGN)  # Node owns Ctrl-C and closes us through the protocol
os.environ.setdefault('ANONYMIZED_TELEMETRY', 'false')
os.environ.setdefault('BROWSER_USE_CLOUD_SYNC', 'false')
os.environ.setdefault('BROWSER_USE_VERSION_CHECK', 'false')
# browser-use calls load_dotenv() on import; it would walk up to the repo's .env and load TYPESAFE_API_KEY, which
# Node deliberately keeps from us. Node already loaded .env and passes on what we need (the LLM keys).
os.environ['PYTHON_DOTENV_DISABLED'] = '1'

import asyncio  # noqa: E402
import glob  # noqa: E402
import json  # noqa: E402

from browser_use import Browser  # noqa: E402

from hide_agent import run_hide_agent  # noqa: E402
from llm import describe, preflight  # noqa: E402
from protocol import BrowserUseConfig, HideResult, SiteBundle  # noqa: E402

# Our own tiny page helpers (not X-specific, so they live here rather than in x.inpage.js).
# Browser Use's Page.evaluate wants a string starting with "(" that contains "=>"; it awaits promises and
# returns a string. (setTimeout, not requestAnimationFrame: rAF can stall in a window you aren't looking at.)

# Where to click an element: wait until it stops moving (smooth scroll, layout shifts), scroll it on screen if
# needed, and hit-test its centre so a sticky header or an overlay can't take the click. We click at these
# coordinates ourselves: Element.click() measures before it scrolls, and on a node that was just re-rendered
# away it can end up clicking at (0, 0).
_CLICK_POINT = """(sel) => (async () => {
  const el = document.querySelector(sel);
  if (!el) return JSON.stringify({ ok: false, why: 'missing' });
  const still = async () => {
    for (let i = 0, last = ''; i < 40; i++) {
      const r = el.getBoundingClientRect(), now = r.left + ',' + r.top;
      if (now === last) return;
      last = now;
      await new Promise((ok) => setTimeout(ok, 30));
    }
  };
  const probe = () => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
  };
  await still();
  let at = probe();
  if (!at) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); await still(); at = probe(); }
  return JSON.stringify(at ? { ok: true, ...at } : { ok: false, why: 'covered' });
})()"""

# Resolves once the page has stopped scrolling (two equal samples 40 ms apart; gives up after ~2 s).
_SCROLL_SETTLED = """() => new Promise((done) => {
  let last = -1, same = 0, n = 0;
  const tick = () => {
    same = scrollY === last ? same + 1 : 0;
    last = scrollY;
    if (same >= 2 || ++n > 50) return done(String(scrollY));
    setTimeout(tick, 40);
  };
  tick();
})"""

_SCROLL = '() => { window.scrollBy(0, Math.round(innerHeight * 0.9)); return String(scrollY); }'


def send(obj: dict) -> None:
	PROTO.write(json.dumps(obj) + '\n')
	PROTO.flush()


def fallback_browser() -> str | None:
	"""Only when browser-use finds no browser at all: the Chromium that `browser-use install` downloads.

	browser-use 0.13.10 looks for Playwright's Chromium as ".../Chromium.app" on macOS, but Playwright now ships
	"Google Chrome for Testing.app" there, so without a system Chrome it would find nothing.
	"""
	from browser_use.browser.watchdogs.local_browser_watchdog import LocalBrowserWatchdog

	if LocalBrowserWatchdog._find_installed_browser_path():
		return None  # e.g. /Applications/Google Chrome.app: browser-use's own choice
	root = os.environ.get('PLAYWRIGHT_BROWSERS_PATH') or '~/Library/Caches/ms-playwright'
	app = 'chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
	found = sorted(glob.glob(os.path.join(os.path.expanduser(root), 'chromium-*', app)))
	return found[-1] if found else None


class XPage:
	"""The feed tab: runs the shared in-page functions and clicks what they stamp. Used by both hide paths."""

	def __init__(self, browser: Browser, bundle: SiteBundle, cfg: BrowserUseConfig):
		self.browser = browser
		self.site = bundle['site']
		self.src = bundle['inpage']
		self.cfg = cfg
		self._page = None
		self._target = None

	async def page(self):
		# One Actor Page per tab: each new Page object attaches its own CDP session, so reuse it.
		target = self.browser.agent_focus_target_id
		if self._page is None or target != self._target:
			self._page = await self.browser.must_get_current_page()
			self._target = target
		return self._page

	async def call(self, name: str, **extra):
		"""Same expression shape as the Node drivers: JSON.stringify((<x.inpage.js>)[name](ctx))."""
		ctx = {'sel': self.site['sel'], 'text': self.site['text'], 'guard': self.site['guard'], **extra}
		fn = f'() => JSON.stringify(({self.src})[{json.dumps(name)}]({json.dumps(ctx)}))'
		return json.loads(await (await self.page()).evaluate(fn))

	async def js(self, fn: str, *args):
		return await (await self.page()).evaluate(fn, *args)

	async def url(self) -> str:
		return await self.browser.get_current_page_url()

	async def click(self, selector: str) -> bool:
		"""A real mouse click on the first element matching selector. False if it isn't there or can't be hit."""
		at = json.loads(await self.js(_CLICK_POINT, selector))
		if not at['ok']:
			return False
		mouse = await (await self.page()).mouse
		x, y = round(at['x']), round(at['y'])
		await mouse.move(x, y)
		await mouse.click(x, y)
		return True

	async def wait_menu(self, label: str | None = None) -> dict:
		"""Poll until a menu is open (menuTimeoutMs). Returns the last menu() result; it stamps the item to click."""
		deadline = asyncio.get_running_loop().time() + self.cfg['menuTimeoutMs'] / 1000
		while True:
			menu = await self.call('menu', **({} if label is None else {'label': label}))
			if menu['open'] or asyncio.get_running_loop().time() > deadline:
				return menu
			await asyncio.sleep(0.1)

	async def close_menu(self) -> None:
		"""Escape only if a menu is open; never leaves one open."""
		for _ in range(5):
			if not (await self.call('menu'))['open']:
				return
			await (await self.page()).press('Escape')
			await asyncio.sleep(0.15)

	async def wait_hidden(self, post_id: str, timeout_s: float = 3.0) -> str:
		"""Poll hideState until the post is no longer 'visible'. Returns the last state."""
		deadline = asyncio.get_running_loop().time() + timeout_s
		while True:
			state = (await self.call('hideState', target=post_id))['state']
			if state != 'visible' or asyncio.get_running_loop().time() > deadline:
				return state
			await asyncio.sleep(0.15)

	async def vanished(self, before: list[str], post_id: str) -> list[str]:
		"""Posts that were mounted before an action and are gone now (other than the target)."""
		now = {p['id'] for p in (await self.call('scan'))['posts']}
		return [i for i in before if i != post_id and i not in now]

	async def still_stamped(self) -> bool:
		"""False once X has re-rendered the stamped post (its nodes, and our stamp, are gone)."""
		return await self.js('() => String(!!document.querySelector("[data-tc-target]"))') == 'true'

	async def open_post_menu(self, button: str) -> dict:
		"""Click a button of the stamped post and wait for its menu. Returns {'clicked', 'menu', 'rerendered'}.

		If the post was re-rendered around the click, whatever menu opened can't be trusted (the click may have
		landed on another post): it is closed and 'rerendered' is True, so the caller can stamp again and retry.
		"""
		clicked = await self.click(button)
		menu = await self.wait_menu() if clicked else {'open': False, 'labels': [], 'stamped': False, 'choice': None}
		if await self.still_stamped():
			return {'clicked': clicked, 'menu': menu, 'rerendered': False}
		await self.close_menu()
		return {'clicked': clicked, 'menu': menu, 'rerendered': True}


async def poll(check, timeout_s: float | None, every_s: float = 0.25):
	"""Call check() until it returns something truthy; None on timeout (timeout_s None = wait forever)."""
	loop = asyncio.get_running_loop()
	deadline = None if timeout_s is None else loop.time() + timeout_s
	while True:
		try:
			value = await check()
			if value:
				return value
		except Exception:
			pass  # e.g. evaluating while the page navigates
		if deadline is not None and loop.time() > deadline:
			return None
		await asyncio.sleep(every_s)


class Server:
	def __init__(self):
		self.browser: Browser | None = None
		self.x: XPage | None = None
		self.cfg: BrowserUseConfig | None = None
		self.agent_runs = 0
		self.cost_usd = 0.0
		self.no_item_streak = 0  # consecutive script no_menu_item results (auto mode escalates on the 3rd)

	# ---------------------------------------------------------------- lifecycle

	async def open(self, bundle: SiteBundle, cfg: BrowserUseConfig) -> dict:
		if self.browser is not None:
			raise RuntimeError('open was already called')
		if 'chrome' in cfg['profileDir'].lower():
			# browser-use copies such a profile to a temp dir and forgets the login when it closes.
			raise RuntimeError(f'profileDir must not contain "chrome": {cfg["profileDir"]}')
		if cfg['hide'] != 'script':
			await preflight(cfg['llm'])  # fail before any browser opens
			print(f'[sidecar] hide agent LLM: {describe(cfg["llm"])}', file=sys.stderr)
		self.cfg = cfg
		self.browser = Browser(
			user_data_dir=cfg['profileDir'],
			headless=cfg['headless'],
			window_size={'width': cfg['window']['width'], 'height': cfg['window']['height']},
			keep_alive=True,  # agent runs must not close our browser
			enable_default_extensions=False,  # no uBlock etc. downloads; X should look like X
			highlight_elements=False,  # no numbered overlays drawn over the feed
		)
		exe = fallback_browser()
		if exe:
			# Set after construction on purpose: passed to Browser(), a path containing "chrome" makes browser-use
			# copy the profile to a temp dir (and forget the login).
			self.browser.browser_profile.executable_path = exe
		await self.browser.start()
		self.x = x = XPage(self.browser, bundle, cfg)
		site = bundle['site']
		await self.browser.navigate_to(site['homeUrl'])

		async def logged_in():
			return await x.call('isLoggedIn')

		if not await poll(logged_in, 8):
			send({'event': 'prompt', 'message': site['text']['loginPrompt']})
			await poll(logged_in, None, 1.0)  # a human is logging in: no timeout

		async def tab():
			state = (await x.call('forYouTab'))['state']
			return None if state == 'missing' else state

		state = await poll(tab, 10)
		if state is None:
			raise RuntimeError('Could not find the "For you" tab (selector drift? check site/x.json)')
		if state == 'stamped':
			await x.click('[data-tc-tab]')

		async def first_post():
			return (await x.call('scan'))['posts']

		if not await poll(first_post, 20):
			raise RuntimeError('No posts showed up on the feed')
		return {'handle': (await x.call('myHandle'))['handle']}

	async def close(self) -> None:
		browser, self.browser, self.x = self.browser, None, None
		if browser is not None:
			await browser.kill()

	# ---------------------------------------------------------------- reading

	async def read_visible_posts(self) -> list:
		return (await self.x.call('scan'))['posts']

	async def focus(self, post_id: str) -> bool:
		smooth = self.cfg.get('smoothScroll', not self.cfg['headless'])  # config.ts run.smoothScroll
		found = (await self.x.call('focus', target=post_id, smooth=smooth))['found']
		if found:
			await self.x.js(_SCROLL_SETTLED)  # return only once the post has arrived at the top
		return found

	async def scroll(self) -> None:
		await self.x.js(_SCROLL)
		await asyncio.sleep(self.cfg['settleMs'] / 1000)

	async def stats(self) -> dict:
		return {'agentRuns': self.agent_runs, 'costUsd': round(self.cost_usd, 6)}

	# ---------------------------------------------------------------- hiding

	async def mark_not_interested(self, post_id: str, commit: bool = True) -> HideResult:
		mode = self.cfg['hide']
		if mode == 'agent':
			return await self.agent(post_id, commit)
		res = await self.script(post_id, commit)
		if mode == 'script' or res['ok']:
			self.no_item_streak = 0
			return res
		reason = res.get('reason')
		if reason == 'no_menu_item':
			self.no_item_streak += 1
			if self.no_item_streak < 3:
				return res  # probably an ad; three in a row smells like a renamed item
			self.no_item_streak = 0
		else:
			self.no_item_streak = 0  # "in a row" means nothing else in between (not_found, unverified, ...)
			if reason not in ('caret_missing', 'menu_not_opened'):
				return res
		print(f'[sidecar] script path failed ({reason}) for {post_id}; asking the agent', file=sys.stderr)
		out = await self.agent(post_id, commit)
		out['hint'] = {'script': res, 'agent': out.get('hint')}
		return out

	async def script(self, post_id: str, commit: bool) -> HideResult:
		"""Deterministic path: stamp the post by id, click its caret, click the stamped "Not interested" item."""
		x = self.x
		caret = f'[data-tc-target] {x.site["sel"]["caret"]}'
		try:
			await x.close_menu()
			for attempt in (1, 2):
				scan = await x.call('scan', target=post_id)
				if not scan['stamped']:
					return {'ok': False, 'via': 'script', 'reason': 'not_found'}
				before = [p['id'] for p in scan['posts']]
				opened = await x.open_post_menu(caret)
				if not opened['rerendered']:
					break
				# X re-rendered the post under us: stamp it again and retry once
			else:
				return {'ok': False, 'via': 'script', 'reason': 'error', 'detail': 'the post kept re-rendering'}
			if not opened['clicked']:
				return {'ok': False, 'via': 'script', 'reason': 'caret_missing'}
			menu = opened['menu']
			if not menu['open']:
				return {'ok': False, 'via': 'script', 'reason': 'menu_not_opened'}
			if not menu['stamped']:
				return {'ok': False, 'via': 'script', 'reason': 'no_menu_item', 'detail': json.dumps(menu['labels'])}
			label = menu['choice']
			if not commit:
				return {'ok': True, 'via': 'script', 'rehearsed': True, 'label': label}
			if not await x.click('[data-tc-choice]'):
				return {'ok': False, 'via': 'script', 'reason': 'error', 'label': label, 'detail': 'menu item not clickable'}
			if await x.wait_hidden(post_id) != 'visible':
				return {'ok': True, 'via': 'script', 'label': label}
			gone = await x.vanished(before, post_id)
			if gone:
				return {'ok': False, 'via': 'script', 'reason': 'wrong_post', 'fatal': True, 'label': label,
						'detail': f'post still shown, but {gone} vanished'}
			return {'ok': False, 'via': 'script', 'reason': 'unverified', 'label': label}
		except Exception as e:
			return {'ok': False, 'via': 'script', 'reason': 'error', 'detail': f'{type(e).__name__}: {e}'}
		finally:
			try:
				await x.close_menu()
			except Exception:
				pass

	async def agent(self, post_id: str, commit: bool) -> HideResult:
		cfg = self.cfg
		if self.agent_runs >= cfg['maxAgentRuns'] or self.cost_usd >= cfg['maxUsd']:
			return {'ok': False, 'via': None, 'reason': 'budget',
					'detail': f'{self.agent_runs} agent runs, ${self.cost_usd:.4f} spent'}
		self.agent_runs += 1
		try:
			res = await run_hide_agent(self.x, cfg, post_id, commit)
		except Exception as e:
			res = {'ok': False, 'via': 'agent', 'reason': 'error', 'detail': f'{type(e).__name__}: {e}'}
		self.cost_usd += res.get('costUsd', 0.0)
		return res

	# ---------------------------------------------------------------- dispatch

	async def handle(self, method: str, p: dict):
		if method == 'open':
			return await self.open(p['bundle'], p['cfg'])
		if method == 'close':
			return await self.close()
		if method == 'stats':
			return await self.stats()
		if self.x is None:
			raise RuntimeError(f'{method} before open')
		if method == 'readVisiblePosts':
			return await self.read_visible_posts()
		if method == 'focus':
			return await self.focus(p['id'])
		if method == 'scroll':
			return await self.scroll()
		if method == 'markNotInterested':
			return await self.mark_not_interested(p['id'], p.get('commit', True))
		raise RuntimeError(f'unknown method {method!r}')


async def main() -> None:
	server = Server()
	lock = asyncio.Lock()  # Node sends one request at a time; this just makes that a guarantee
	running: set[asyncio.Task] = set()

	async def serve(req: dict) -> None:
		async with lock:
			try:
				send({'id': req.get('id'), 'result': await server.handle(req.get('method'), req.get('params') or {})})
			except asyncio.CancelledError:
				raise
			except Exception as e:
				send({'id': req.get('id'), 'error': {'message': f'{type(e).__name__}: {e}'}})

	while True:
		line = await asyncio.to_thread(sys.stdin.readline)
		if not line:
			break  # stdin EOF: Node is gone or done
		try:
			req = json.loads(line)
		except ValueError:
			print(f'[sidecar] ignoring a non-JSON line: {line[:80]!r}', file=sys.stderr)
			continue
		if req.get('method') == 'close':
			# Don't queue close behind a request that may never finish (open waiting for a login).
			for t in list(running):
				t.cancel()
			await asyncio.gather(*running, return_exceptions=True)
		task = asyncio.create_task(serve(req))
		running.add(task)
		task.add_done_callback(running.discard)

	for t in list(running):
		t.cancel()
	await asyncio.gather(*running, return_exceptions=True)
	try:
		await server.close()
	except Exception as e:
		print(f'[sidecar] close failed: {e}', file=sys.stderr)


if __name__ == '__main__':
	asyncio.run(main())

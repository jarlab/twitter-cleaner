"""LLM factory for the hide agent: make_llm(cfg) turns an LlmConfig (see protocol.py) into a browser-use chat model.

Free / open-source options first: Ollama (local), OpenRouter (":free" models), Vercel AI Gateway, Groq, Cerebras,
or any OpenAI-compatible server (LM Studio, vLLM, llama.cpp). 'scripted' is a deterministic fake for tests.
Every class name and argument here was checked against browser-use 0.13.10 (browser_use/llm/*/chat.py).
"""

import json
import os
import re

import httpx

from protocol import LlmConfig

# Env var holding each provider's key (mirrors bot/src/llm.ts). None = no key needed.
KEY_ENV: dict[str, str | None] = {
	'ollama': None,
	'scripted': None,
	'openai-compatible': None,  # only if cfg.apiKeyEnv says so
	'openrouter': 'OPENROUTER_API_KEY',
	'vercel': 'AI_GATEWAY_API_KEY',  # VERCEL_OIDC_TOKEN also accepted
	'groq': 'GROQ_API_KEY',
	'cerebras': 'CEREBRAS_API_KEY',
	'openai': 'OPENAI_API_KEY',
	'anthropic': 'ANTHROPIC_API_KEY',
	'google': 'GOOGLE_API_KEY',
	'browser-use': 'BROWSER_USE_API_KEY',
}

# Models that run on your own machine (or a server you host): their cost is only our llm.prices estimate ($0 when
# unset), never browser-use's price table, which would look a "publisher/model" id up at OpenRouter.
LOCAL_PROVIDERS = frozenset({'ollama', 'openai-compatible', 'scripted'})


def describe(cfg: LlmConfig) -> str:
	return f'{cfg["provider"]}:{cfg["model"]}'


def _key(cfg: LlmConfig) -> str | None:
	"""The API key from the environment, or None when the provider needs none. Raises if a needed key is missing."""
	env = cfg.get('apiKeyEnv') or KEY_ENV.get(cfg['provider'])
	if env is None:
		return None
	key = os.environ.get(env)
	if not key and cfg['provider'] == 'vercel' and not cfg.get('apiKeyEnv'):
		key = os.environ.get('VERCEL_OIDC_TOKEN')
	if not key:
		raise RuntimeError(f'{describe(cfg)} needs {env} in the environment (put it in .env).')
	return key


def ollama_host(cfg: LlmConfig) -> str:
	"""baseUrl or OLLAMA_HOST, read exactly the way the ollama client reads it: "0.0.0.0" and "localhost" mean port
	11434, ":11500" means 127.0.0.1:11500, unset means http://127.0.0.1:11434. (A private helper, but the ollama
	version is pinned in uv.lock, and ChatOllama parses the host with it too.)"""
	from ollama._client import _parse_host

	return _parse_host(cfg.get('baseUrl') or os.environ.get('OLLAMA_HOST'))


def make_llm(cfg: LlmConfig):
	"""Construct the chat model. Imports lazily so a missing optional SDK only breaks the provider that needs it."""
	provider, model = cfg['provider'], cfg['model']
	temp = cfg.get('temperature')
	extra = {} if temp is None else {'temperature': temp}
	base_url = cfg.get('baseUrl')

	if provider == 'scripted':
		return ScriptedLLM(model)
	if provider == 'ollama':
		from browser_use import ChatOllama

		return ChatOllama(model=model, host=ollama_host(cfg), ollama_options=extra or None)
	if provider == 'openrouter':
		from browser_use import ChatOpenRouter

		return ChatOpenRouter(model=model, api_key=_key(cfg), **({'base_url': base_url} if base_url else {}), **extra)
	if provider == 'vercel':
		from browser_use import ChatVercel

		return ChatVercel(model=model, api_key=_key(cfg), **({'base_url': base_url} if base_url else {}), **extra)
	if provider == 'groq':
		from browser_use import ChatGroq

		return ChatGroq(model=model, api_key=_key(cfg), base_url=base_url, **extra)
	if provider == 'cerebras':
		from browser_use import ChatCerebras

		# ChatCerebras hands api_key=None to the OpenAI client, which would then read OPENAI_API_KEY: always pass it.
		return ChatCerebras(model=model, api_key=_key(cfg), **({'base_url': base_url} if base_url else {}), **extra)
	if provider == 'openai-compatible':
		from browser_use import ChatOpenAI

		if not base_url:
			raise RuntimeError('openai-compatible needs baseUrl (e.g. http://localhost:1234/v1 for LM Studio).')
		# Local servers ignore the key, but the OpenAI client insists on one.
		return ChatOpenAI(model=model, base_url=base_url, api_key=_key(cfg) or 'not-needed', **extra)
	if provider == 'openai':
		from browser_use import ChatOpenAI

		return ChatOpenAI(model=model, api_key=_key(cfg), base_url=base_url, **extra)
	if provider == 'anthropic':
		from browser_use import ChatAnthropic

		return ChatAnthropic(model=model, api_key=_key(cfg), base_url=base_url, **extra)
	if provider == 'google':
		from browser_use import ChatGoogle

		return ChatGoogle(model=model, api_key=_key(cfg), **extra)
	if provider == 'browser-use':
		from browser_use import ChatBrowserUse

		return ChatBrowserUse(model=model, api_key=_key(cfg), **({'base_url': base_url} if base_url else {}))
	raise RuntimeError(f'Unknown LLM provider {provider!r}')


async def preflight(cfg: LlmConfig) -> None:
	"""Fail before the browser opens: construct the model (checks keys), and for Ollama check the server and the model."""
	make_llm(cfg)
	if cfg['provider'] != 'ollama':
		return
	host = ollama_host(cfg)
	try:
		async with httpx.AsyncClient(timeout=5) as client:
			tags = (await client.get(f'{host}/api/tags')).json()
	except Exception as e:
		raise RuntimeError(
			f'Ollama is not reachable at {host} ({type(e).__name__}). Start it with: ollama serve '
			'(or pick another --llm, or --hide script to run without an LLM)'
		) from e
	names = {m.get('name') for m in tags.get('models', [])} | {m.get('model') for m in tags.get('models', [])}
	model = cfg['model']
	if model not in names and f'{model}:latest' not in names:
		raise RuntimeError(f'Ollama has no model {model!r}. Pull it with: ollama pull {model}  (have: {sorted(n for n in names if n)})')


# ---------------------------------------------------------------- scripted fake (tests, $0)

# hide_agent.py's tools put these markers in their results; the scripted model reads them back from the messages.
MENU_OPENED = 'Menu opened. Items:'  # followed by a JSON list of labels
REFUSED = 'Refused:'

# Tests set this to a file path: ScriptedLLM appends every prompt it is sent, so they can check what an LLM would see.
TRANSCRIPT_ENV = 'TC_SCRIPTED_LLM_TRANSCRIPT'

# Matches the {"n": 0, "label": "More"} objects that hide_agent.py puts in the task.
_BUTTON = re.compile(r'\{"n": (\d+), "label": "((?:[^"\\]|\\.)*)"\}')


def _last_menu(text: str) -> list[str] | None:
	"""Labels from the most recent "menu opened" tool result, or None if no menu was opened yet."""
	i = text.rfind(MENU_OPENED)
	if i < 0:
		return None
	try:
		labels, _ = json.JSONDecoder().raw_decode(text, text.index('[', i))
		return labels
	except ValueError:
		return []


class ScriptedLLM:
	"""A fake chat model that satisfies browser-use's BaseChatModel protocol (model, provider, name, ainvoke).

	It never calls a network. Each ainvoke reads the task and our tools' results out of `messages` and returns
	the next action, validated against the `output_format` the Agent passes (its flash-mode AgentOutput), so it
	goes through exactly the same parsing as a real model's JSON. Models:
	  happy     click the "More" button, then choose the label containing "Not interested"
	  trap      click "More", try a forbidden label first ("Block @x"), then no_matching_item once refused
	  rogue     click "More", try the first label that is neither "not interested" nor has an "@" (e.g. "Report post",
	            or "Beitrag melden" on a German menu), then no_matching_item once refused
	  confused  click "More", choose a label that is not in the menu, then give up with done
	"""

	_verified_api_keys = True  # Agent skips its API-key check

	def __init__(self, model: str):
		if model not in ('happy', 'trap', 'rogue', 'confused'):
			raise RuntimeError(f'scripted model must be happy, trap, rogue or confused, not {model!r}')
		self.model = model

	@property
	def provider(self) -> str:
		return 'scripted'

	@property
	def name(self) -> str:
		return self.model

	@property
	def model_name(self) -> str:
		return self.model

	def _decide(self, text: str) -> tuple[str, dict]:
		menu = _last_menu(text)
		if menu is None:
			buttons = [(int(n), json.loads(f'"{label}"')) for n, label in _BUTTON.findall(text)]
			more = next((n for n, label in buttons if 'more' in label.lower()), buttons[0][0] if buttons else 0)
			return 'click_post_button', {'n': more}
		refused = text.rfind(REFUSED) > text.rfind(MENU_OPENED)
		if self.model == 'happy':
			pick = next((label for label in menu if 'not interested' in label.lower()), None)
			return ('choose_menu_item', {'label': pick}) if pick else ('no_matching_item', {})
		if self.model == 'trap':
			if refused:
				return 'no_matching_item', {}
			bad = next((label for label in menu if 'block' in label.lower()), None)
			bad = bad or next((label for label in menu if '@' in label), menu[0] if menu else 'Block @x')
			return 'choose_menu_item', {'label': bad}
		if self.model == 'rogue':
			bad = next((label for label in menu if '@' not in label and 'interes' not in label.lower()), None)
			return ('choose_menu_item', {'label': bad}) if bad and not refused else ('no_matching_item', {})
		# confused
		if refused:
			return 'done', {'text': 'I could not find the item.', 'success': False}
		return 'choose_menu_item', {'label': 'Hide this forever please'}

	async def ainvoke(self, messages, output_format=None, **kwargs):
		from browser_use.llm.views import ChatInvokeCompletion
		from pydantic import ValidationError

		if output_format is None:  # e.g. message compaction asks for plain text
			return ChatInvokeCompletion(completion='(scripted)', usage=None)
		text = '\n'.join(m.text for m in messages)
		if path := os.environ.get(TRANSCRIPT_ENV):
			with open(path, 'a', encoding='utf-8') as f:
				f.write(text + '\n\n')
		name, params = self._decide(text)
		try:
			parsed = output_format.model_validate({'memory': f'scripted {self.model}', 'action': [{name: params}]})
		except ValidationError:
			# e.g. the last step, where the Agent only offers `done`
			parsed = output_format.model_validate(
				{'memory': 'scripted: only done is allowed', 'action': [{'done': {'text': 'Out of steps.', 'success': False}}]}
			)
		return ChatInvokeCompletion(completion=parsed, usage=None)

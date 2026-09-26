"""Python mirror of bot/src/drivers/types.ts (the sidecar's side of the contract).

Only plain JSON crosses the wire, so these are TypedDicts: they document the shapes and let an editor
check field names, nothing more. Keep them in sync with types.ts.
"""

from typing import Literal, NotRequired, TypedDict

# ---------------------------------------------------------------- feed


class Post(TypedDict):
	id: str  # status id from the post's OWN permalink
	author: str  # handle as shown, no "@"
	text: str  # first tweetText block ('' when media-only)
	quoted: str | None  # second tweetText block (the quoted post), if any


FailReason = Literal[
	'not_found',  # no mounted article has that id: benign
	'caret_missing',  # article found, its "More" button not: selector drift
	'menu_not_opened',  # button clicked, no role=menu appeared: selector drift
	'no_menu_item',  # menu open, no "not interested" item (ads): benign
	'unverified',  # clicked, but the post is still shown
	'wrong_post',  # target still shown and a DIFFERENT post vanished (fatal)
	'budget',  # agent run refused: maxAgentRuns / maxUsd reached
	'gave_up',  # agent stopped without finishing through our tools
	'error',
]


class HideResult(TypedDict):
	ok: bool
	via: Literal['script', 'agent'] | None
	rehearsed: NotRequired[bool]
	reason: NotRequired[FailReason]
	label: NotRequired[str | None]
	costUsd: NotRequired[float]
	hint: NotRequired[object]
	detail: NotRequired[str]
	fatal: NotRequired[bool]


class DriverStats(TypedDict):
	agentRuns: int
	costUsd: float


# ---------------------------------------------------------------- LLM (agent only)

LlmProvider = Literal[
	'ollama',
	'openrouter',
	'vercel',
	'groq',
	'cerebras',
	'openai-compatible',
	'openai',
	'anthropic',
	'google',
	'browser-use',
	'scripted',
]


# $ per 1M tokens. 'in' is a Python keyword, hence the functional syntax.
Prices = TypedDict('Prices', {'in': float, 'out': float})


class LlmConfig(TypedDict):
	provider: LlmProvider
	model: str
	baseUrl: NotRequired[str]  # required for openai-compatible; optional override otherwise
	apiKeyEnv: NotRequired[str]  # env var holding the key (overrides the provider default)
	temperature: NotRequired[float]
	prices: NotRequired[Prices]  # for the USD cap; omit for free/local models


HideMode = Literal['script', 'auto', 'agent']


class WindowSize(TypedDict):
	width: int
	height: int


class BrowserUseConfig(TypedDict):
	profileDir: str  # absolute; must not contain "chrome"
	headless: bool
	window: WindowSize
	settleMs: int
	menuTimeoutMs: int
	hide: HideMode
	llm: LlmConfig
	maxAgentRuns: int
	maxUsd: float
	maxStepsPerHide: int
	agentTimeoutS: float
	smoothScroll: NotRequired[bool]  # animate focus() scrolls; default: not headless


# ---------------------------------------------------------------- site/x.json


class SiteSelectors(TypedDict):
	loggedIn: str
	handle: str
	article: str
	cell: str
	tweetText: str
	caret: str
	tab: str
	menuItem: str
	button: str


class SiteText(TypedDict):
	forYou: str
	notInterested: str
	hiddenNotice: str  # regex source, case-insensitive
	loginPrompt: str


class SiteGuard(TypedDict):
	allowMenu: str  # regex source: the only labels the agent may choose ("not interested" wordings)
	denyMenu: str  # regex source: labels the agent may never choose
	denyButtonTestid: str
	denyButtonLabel: str


class SiteConfig(TypedDict):
	homeUrl: str
	sel: SiteSelectors
	text: SiteText
	guard: SiteGuard
	agentTask: str  # {id} and {buttons} are substituted
	agentRules: str


class SiteBundle(TypedDict):
	site: SiteConfig
	inpage: str  # source text of site/x.inpage.js


# ---------------------------------------------------------------- JSON lines

Method = Literal['open', 'readVisiblePosts', 'focus', 'scroll', 'markNotInterested', 'stats', 'close']


class RpcRequest(TypedDict):
	id: int
	method: Method
	params: dict


class RpcError(TypedDict):
	message: str


class RpcResult(TypedDict):
	id: int
	result: object


class RpcFailure(TypedDict):
	id: int
	error: RpcError


class PromptEvent(TypedDict):
	event: Literal['prompt']
	message: str

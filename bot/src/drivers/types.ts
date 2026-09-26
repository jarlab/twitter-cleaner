// The only contract run.ts knows. Rules for every driver:
//  * Only plain JSON crosses it: no Locators or element handles (the browser-use driver lives in Python).
//  * Actions are keyed by post id; the driver finds the post again at action time.
//  * Reading the feed never uses an LLM.
//  * Drivers know nothing about dry-run, limits, pacing or logging.
// bot/browser-use/protocol.py mirrors these types; keep them in sync.

export type Post = {
  id: string; // status id from the post's OWN permalink (the /status/ link that contains <time>)
  author: string; // handle as shown, no "@"
  text: string; // first tweetText block ('' when media-only)
  quoted: string | null; // second tweetText block (the quoted post), if any
};

export type FailReason =
  | 'not_found' // no mounted article has that id (virtualised away): benign
  | 'caret_missing' // article found, its "More" button not: selector drift
  | 'menu_not_opened' // button clicked, no role=menu appeared: selector drift
  | 'no_menu_item' // menu open, no "not interested" item (ads): benign
  | 'unverified' // clicked, but the post is still shown
  | 'wrong_post' // target still shown and a DIFFERENT post vanished (fatal)
  | 'budget' // agent run refused: maxAgentRuns / maxUsd reached
  | 'gave_up' // agent stopped without finishing through our tools
  | 'error';

export type HideResult = {
  ok: boolean;
  via: 'script' | 'agent' | null; // which path did the work
  rehearsed?: boolean; // commit:false: menu walked, item found, Escape pressed, nothing clicked
  reason?: FailReason; // set when ok === false
  label?: string | null; // menu label clicked (or that would have been)
  costUsd?: number; // LLM spend for this call (agent path only)
  hint?: unknown; // what the agent saw/chose, for fixing site/x.json by hand
  detail?: string;
  fatal?: boolean; // the driver says: stop the run
};

export type DriverStats = { agentRuns: number; costUsd: number };

export interface FeedDriver {
  readonly name: DriverName;
  /**
   * Launch a headed browser on this driver's own profile. If logged out, call onPrompt once, then wait
   * with NO timeout while the user logs in by hand. The driver never types credentials.
   * Then select "For you" (throw if impossible) and wait for the first post.
   */
  open(o: { onPrompt: (msg: string) => void }): Promise<{ handle: string | null }>;
  /** Every mounted post, in feed order, in ONE round-trip. */
  readVisiblePosts(): Promise<Post[]>;
  /**
   * Scroll so post `id` sits at the top of the viewport (below X's sticky header) and outline it,
   * i.e. "move to the next post". Returns false if the post is no longer mounted.
   */
  focus(id: string): Promise<boolean>;
  /** Scroll about one screen further (to load more posts); the driver owns the settle time. */
  scroll(): Promise<void>;
  /**
   * Find the post by id, open its menu, choose "Not interested", then verify the post left the feed.
   * Expected failures come back as ok:false; it throws only when the driver itself is broken.
   * It always leaves no menu open.
   */
  markNotInterested(id: string, o?: { commit?: boolean }): Promise<HideResult>;
  stats(): Promise<DriverStats | null>;
  /** Idempotent; called from finally and on Ctrl-C. */
  close(): Promise<void>;
}

export type DriverName = 'playwright' | 'browser-use' | 'fake';

// ---------------------------------------------------------------- LLM (browser-use agent only)

export type LlmProvider =
  | 'ollama' // local, free: ChatOllama(model, host)
  | 'openrouter' // ChatOpenRouter, OPENROUTER_API_KEY (":free" models cost $0)
  | 'vercel' // ChatVercel (Vercel AI Gateway), AI_GATEWAY_API_KEY
  | 'groq' // ChatGroq, GROQ_API_KEY
  | 'cerebras' // ChatCerebras, CEREBRAS_API_KEY
  | 'openai-compatible' // ChatOpenAI(base_url=...): LM Studio, vLLM, llama.cpp, Together, ...
  | 'openai' // ChatOpenAI, OPENAI_API_KEY
  | 'anthropic' // ChatAnthropic, ANTHROPIC_API_KEY
  | 'google' // ChatGoogle, GOOGLE_API_KEY
  | 'browser-use' // ChatBrowserUse, BROWSER_USE_API_KEY
  | 'scripted'; // deterministic fake for tests: no network, no key

export type LlmConfig = {
  provider: LlmProvider;
  model: string;
  baseUrl?: string; // required for openai-compatible; optional override (e.g. Ollama host) otherwise
  apiKeyEnv?: string; // env var holding the key (openai-compatible; overrides the provider default)
  temperature?: number;
  prices?: { in: number; out: number }; // $ per 1M tokens, for the USD cap; omit for free/local models
};

export type HideMode = 'script' | 'auto' | 'agent';

export type BrowserUseConfig = {
  profileDir: string; // absolute; must not contain "chrome" (browser-use would copy the profile)
  headless: boolean;
  window: { width: number; height: number };
  settleMs: number;
  menuTimeoutMs: number;
  hide: HideMode; // script: no LLM | auto: agent only on selector drift | agent: always
  llm: LlmConfig;
  maxAgentRuns: number;
  maxUsd: number;
  maxStepsPerHide: number;
  agentTimeoutS: number;
  smoothScroll?: boolean; // animate focus() scrolls (createDriver passes config.ts run.smoothScroll); default: !headless
};

// ---------------------------------------------------------------- sidecar protocol (JSON lines)
// Node -> Python on stdin, one JSON object per line. Python -> Node on stdout. Logs go to stderr.

export type SiteBundle = {
  site: SiteConfig; // contents of site/x.json
  inpage: string; // source text of site/x.inpage.js (an expression evaluating to an object of functions)
};

export type RpcRequest =
  | { id: number; method: 'open'; params: { bundle: SiteBundle; cfg: BrowserUseConfig } }
  | { id: number; method: 'readVisiblePosts'; params: Record<string, never> }
  | { id: number; method: 'focus'; params: { id: string } }
  | { id: number; method: 'scroll'; params: Record<string, never> }
  | { id: number; method: 'markNotInterested'; params: { id: string; commit: boolean } }
  | { id: number; method: 'stats'; params: Record<string, never> }
  | { id: number; method: 'close'; params: Record<string, never> };

export type RpcResponse =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { event: 'prompt'; message: string }; // unsolicited: ask the user to log in

// ---------------------------------------------------------------- site/x.json

export type SiteConfig = {
  homeUrl: string;
  sel: {
    loggedIn: string;
    handle: string;
    article: string;
    cell: string;
    tweetText: string;
    caret: string;
    tab: string;
    menuItem: string;
    button: string;
  };
  text: {
    forYou: string;
    notInterested: string;
    hiddenNotice: string; // regex source, case-insensitive
    loginPrompt: string;
  };
  guard: {
    allowMenu: string; // regex source: the only menu labels the agent may choose (all else is refused)
    denyMenu: string; // regex source: menu labels the agent may never choose
    denyButtonTestid: string; // regex source: post buttons never offered to the agent
    denyButtonLabel: string; // regex source
  };
  agentTask: string; // {id} and {buttons} are substituted
  agentRules: string;
};

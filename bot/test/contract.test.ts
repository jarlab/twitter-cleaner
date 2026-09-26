// The FeedDriver contract: the SAME suite runs against every real driver, headless, on the fake X feed
// (test/fixtures/fake_x.html) served over http. The browser-use half skips itself when its Python
// side isn't installed or its Node proxy can't be imported.
//
// The test can't reach into the driver's browser (for browser-use it lives in another process), so the
// served page carries a small probe: it reports window.__clicks etc. to this server whenever they
// change, and clicks the fixture's "Log in" button when the test says so (playing the human).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { defaultConfig, type Config, type DriverChoice } from '../src/config.js';
import { createDriver } from '../src/drivers/index.js';
import type { FeedDriver, HideMode, LlmConfig } from '../src/drivers/types.js';
import { SITE } from '../src/site/index.js';

const BOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = fs.readFileSync(path.join(BOT, 'test/fixtures/fake_x.html'), 'utf8');
const NOT_INTERESTED = 'Not interested in this post';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixture server + probe

type PageState = {
  clicks: { post: string; label: string }[];
  hidden: string[];
  scrollY: number;
  menuOpen: boolean;
  focusTop: number | null; // viewport top of the post outlined by focus()
};

const PROBE = `<script>
(() => {
  const session = new URLSearchParams(location.search).get('session');
  let last = '';
  setInterval(async () => {
    const focused = document.querySelector('[data-tc-focus]');
    const s = JSON.stringify({
      clicks: window.__clicks, hidden: window.__hidden, scrollY: Math.round(scrollY),
      menuOpen: !!document.querySelector('[role="menu"]'),
      focusTop: focused ? Math.round(focused.getBoundingClientRect().top) : null,
    });
    if (s !== last) {
      last = s;
      fetch('/__state?session=' + session, { method: 'POST', body: s }).catch(() => { last = ''; });
    }
    const login = document.getElementById('login');
    if (login && (await fetch('/__login?session=' + session).then((r) => r.text(), () => '')) === 'yes') login.click();
  }, 100);
})();
</script>`;

const states = new Map<string, PageState>();
const loginAllowed = new Set<string>();
let origin = '';
let sessions = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const session = url.searchParams.get('session') ?? '';
  if (url.pathname === '/__state' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      states.set(session, JSON.parse(body));
      res.end();
    });
  } else if (url.pathname === '/__login') {
    res.end(loginAllowed.has(session) ? 'yes' : 'no');
  } else if (url.pathname === '/home') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FIXTURE.replace('</body>', `${PROBE}\n</body>`));
  } else {
    res.statusCode = 404;
    res.end();
  }
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// ---------------------------------------------------------------- drivers under test

const BU_DIR = path.join(BOT, 'browser-use');
async function browserUseSkip(): Promise<string | false> {
  if (!fs.existsSync(path.join(BU_DIR, '.venv'))) return 'bot/browser-use/.venv missing (npm run setup:bu)';
  if (!fs.existsSync(path.join(BU_DIR, 'server.py'))) return 'bot/browser-use/server.py missing';
  try {
    await import('../src/drivers/browser-use.js');
  } catch (err) {
    return `cannot import src/drivers/browser-use.ts: ${(err as Error).message}`;
  }
  return false;
}
const SKIP: Record<DriverChoice, string | false> = {
  playwright: false,
  'browser-use': await browserUseSkip(),
};

type Session = { driver: FeedDriver; session: string; profileDir: string; prompts: string[]; handle: string | null };
type Variant = { query?: string; hide?: HideMode; llm?: LlmConfig; login?: 'auto' | 'manual' };

// Opens a fresh driver (own temp profile) on the fixture. With login 'manual', the probe clicks
// "Log in" only after the driver has asked the human to log in (onPrompt).
async function openSession(name: DriverChoice, v: Variant = {}): Promise<Session> {
  const session = String(++sessions);
  const homeUrl = `${origin}/home?session=${session}${v.query ? `&${v.query}` : ''}`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-contract-${name}-`));
  const cfg: Config = defaultConfig();
  cfg.run.smoothScroll = false;
  cfg.playwright = { ...cfg.playwright, profileDir, headless: true, homeUrl, settleMs: 300, menuTimeoutMs: 3000 };
  cfg.browserUse = {
    ...cfg.browserUse,
    profileDir,
    headless: true,
    homeUrl,
    settleMs: 300,
    hide: v.hide ?? 'script',
    llm: v.llm ?? { provider: 'scripted', model: 'happy' },
    maxAgentRuns: 5,
    agentTimeoutS: 60,
  };
  const driver = await createDriver(name, cfg);
  const prompts: string[] = [];
  try {
    const { handle } = await driver.open({
      onPrompt: (msg) => {
        prompts.push(msg);
        loginAllowed.add(session); // the "human" logs in now
      },
    });
    return { driver, session, profileDir, prompts, handle };
  } catch (err) {
    await driver.close();
    throw err;
  }
}

async function closeSession(s: Session | undefined): Promise<void> {
  if (!s) return;
  await s.driver.close();
  fs.rmSync(s.profileDir, { recursive: true, force: true });
}

// What the page looks like now (the probe reports changes every 100 ms).
async function pageState(s: Session): Promise<PageState> {
  await sleep(500);
  const st = states.get(s.session);
  assert.ok(st, 'the page never reported its state');
  return st;
}

// ---------------------------------------------------------------- the shared suite

for (const name of ['playwright', 'browser-use'] as const) {
  describe(`FeedDriver contract: ${name}`, { skip: SKIP[name], timeout: 300_000 }, () => {
    describe('one session', () => {
      let s: Session;
      before(async () => {
        s = await openSession(name);
      });
      after(async () => {
        await closeSession(s);
      });

      it('open returns the logged-in handle without prompting', () => {
        assert.equal(s.handle, 'me');
        assert.deepEqual(s.prompts, []);
      });

      it('readVisiblePosts returns plain posts in feed order', async () => {
        const posts = await s.driver.readVisiblePosts();
        assert.ok(Array.isArray(posts));
        assert.deepEqual(
          posts.slice(0, 6).map((p) => p.id),
          ['1000', '1001', '1002', '1003', '1004', '1005'],
        );
        for (const p of posts) assert.deepEqual(Object.keys(p).sort(), ['author', 'id', 'quoted', 'text']);
        const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
        assert.equal(byId['1002']!.quoted, 'Quoted text from zed');
        assert.equal(byId['1003']!.quoted, null);
        assert.equal(byId['1004']!.author, 'Me');
        assert.equal(byId['1005']!.text, '');
        assert.ok(!posts.some((p) => p.id === '91002'), 'the quoted post is not a post of its own');
      });

      it('focus moves the post to the top of the viewport; false for unknown ids', async () => {
        const before = (await pageState(s)).scrollY;
        assert.equal(await s.driver.focus('1001'), true);
        const st = await pageState(s);
        assert.ok(st.scrollY > before, `scrollY ${before} -> ${st.scrollY}`);
        assert.ok(st.focusTop !== null && st.focusTop >= 40 && st.focusTop <= 100, `post top at ${st.focusTop}`);
        assert.equal(await s.driver.focus('999999'), false);
      });

      it('scroll moves further down the feed', async () => {
        const before = (await pageState(s)).scrollY;
        await s.driver.scroll();
        assert.ok((await pageState(s)).scrollY > before);
        await s.driver.focus('1000'); // back to the top for the menu tests
      });

      it('commit:false rehearses: item found, nothing clicked, no menu left open', async () => {
        const r = await s.driver.markNotInterested('1001', { commit: false });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.rehearsed, true);
        assert.equal(r.label, NOT_INTERESTED);
        const st = await pageState(s);
        assert.deepEqual(st.clicks, []);
        assert.equal(st.menuOpen, false);
        assert.ok((await s.driver.readVisiblePosts()).some((p) => p.id === '1001'));
      });

      it('hides the post by id, and only that post', async () => {
        const r = await s.driver.markNotInterested('1001');
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.via, 'script');
        assert.ok(!r.rehearsed);
        const st = await pageState(s);
        assert.deepEqual(st.clicks, [{ post: '1001', label: NOT_INTERESTED }]);
        assert.deepEqual(st.hidden, ['1001']);
        assert.equal(st.menuOpen, false);
        assert.ok(!(await s.driver.readVisiblePosts()).some((p) => p.id === '1001'));
      });

      it('an unknown id is not_found', async () => {
        const r = await s.driver.markNotInterested('999999');
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'not_found');
      });

      it('an ad (no "Not interested" item) is no_menu_item and leaves no menu open', async () => {
        const r = await s.driver.markNotInterested('1003');
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'no_menu_item');
        const st = await pageState(s);
        assert.equal(st.menuOpen, false);
        assert.equal(st.clicks.length, 1); // still just the earlier hide
      });

      it('close is idempotent', async () => {
        await s.driver.close();
        await s.driver.close();
      });
    });

    it('hides the RIGHT post by id while the feed re-renders (?shuffle=1)', async () => {
      const s = await openSession(name, { query: 'shuffle=1' });
      try {
        const a = await s.driver.markNotInterested('1001'); // races the re-render 800 ms after load
        await sleep(1000); // now every node has been replaced, in reverse order
        const b = await s.driver.markNotInterested('1000');
        assert.equal(a.ok, true, JSON.stringify(a));
        assert.equal(b.ok, true, JSON.stringify(b));
        const st = await pageState(s);
        assert.deepEqual(st.clicks, [
          { post: '1001', label: NOT_INTERESTED },
          { post: '1000', label: NOT_INTERESTED },
        ]);
        assert.deepEqual(st.hidden, ['1001', '1000']);
      } finally {
        await closeSession(s);
      }
    });

    it('selector drift (?drift=1) on the script path is caret_missing', async () => {
      const s = await openSession(name, { query: 'drift=1' });
      try {
        const r = await s.driver.markNotInterested('1001');
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'caret_missing', JSON.stringify(r));
        assert.deepEqual((await pageState(s)).clicks, []);
      } finally {
        await closeSession(s);
      }
    });

    it('logged out: prompts, waits for the human to log in, then opens', async () => {
      const s = await openSession(name, { query: 'logged_out=1' });
      try {
        assert.deepEqual(s.prompts, [SITE.text.loginPrompt]);
        assert.equal(s.handle, 'me');
      } finally {
        await closeSession(s);
      }
    });

    // The agent path, on the scripted fake LLM: deterministic, no network, $0.
    if (name === 'browser-use') {
      describe('agent (scripted LLM)', () => {
        it('hide:agent + happy => ok via the agent; the LLM never sees post text; no screenshots left behind', async () => {
          // The scripted LLM appends every prompt it gets to this file (llm.py TRANSCRIPT_ENV).
          const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-')), 'llm.txt');
          const agentDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('browser_use_agent_')));
          const dirsBefore = agentDirs();
          process.env.TC_SCRIPTED_LLM_TRANSCRIPT = transcript;
          const s = await openSession(name, { hide: 'agent', llm: { provider: 'scripted', model: 'happy' } });
          try {
            const posts = await s.driver.readVisiblePosts();
            const r = await s.driver.markNotInterested('1001');
            assert.equal(r.ok, true, JSON.stringify(r));
            assert.equal(r.via, 'agent');
            const st = await pageState(s);
            assert.deepEqual(st.clicks, [{ post: '1001', label: NOT_INTERESTED }]);
            const stats = await s.driver.stats();
            assert.equal(stats?.agentRuns, 1);
            assert.equal(stats?.costUsd, 0);

            const seen = fs.readFileSync(transcript, 'utf8');
            assert.match(seen, /post id 1001/); // the task did reach the model
            assert.match(seen, new RegExp(NOT_INTERESTED)); // and so did the menu labels
            const texts = posts.flatMap((p) => [p.text, p.quoted]).filter((t): t is string => !!t);
            assert.ok(texts.length >= 4);
            for (const t of texts) assert.ok(!seen.includes(t.slice(0, 20)), `post text reached the LLM: "${t.slice(0, 40)}"`);
            assert.ok(!/lorem ipsum/i.test(seen), 'post text reached the LLM');

            const left = [...agentDirs()].filter((d) => !dirsBefore.has(d));
            assert.deepEqual(left, [], 'browser-use left its agent directory (screenshots of the feed) in $TMPDIR');
          } finally {
            delete process.env.TC_SCRIPTED_LLM_TRANSCRIPT;
            fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
            await closeSession(s);
          }
        });

        it('?trap=1 + trap => no_menu_item and zero forbidden clicks', async () => {
          const s = await openSession(name, { query: 'trap=1', hide: 'agent', llm: { provider: 'scripted', model: 'trap' } });
          try {
            const r = await s.driver.markNotInterested('1001');
            assert.equal(r.ok, false);
            assert.equal(r.reason, 'no_menu_item', JSON.stringify(r));
            assert.equal(r.via, 'agent');
            const deny = new RegExp(SITE.guard.denyMenu, 'i');
            // The trap model really did reach for a forbidden item, and our tool refused it.
            const refused = ((r.hint as { refused?: string[] } | undefined)?.refused ?? []).filter((l) => deny.test(l));
            assert.ok(refused.length > 0, `no forbidden label was attempted: ${JSON.stringify(r.hint)}`);
            const st = await pageState(s);
            assert.deepEqual(st.clicks.filter((c) => deny.test(c.label)), []);
            assert.deepEqual(st.clicks, []);
            assert.equal(st.menuOpen, false);
          } finally {
            await closeSession(s);
          }
        });

        it('?drift=1 + auto + happy => the script fails (caret_missing), the agent succeeds', async () => {
          const s = await openSession(name, { query: 'drift=1', hide: 'auto', llm: { provider: 'scripted', model: 'happy' } });
          try {
            const r = await s.driver.markNotInterested('1001');
            assert.equal(r.ok, true, JSON.stringify(r));
            assert.equal(r.via, 'agent');
            // auto escalated only because the script path failed on the renamed caret
            const script = (r.hint as { script?: { reason?: string } } | undefined)?.script;
            assert.equal(script?.reason, 'caret_missing', JSON.stringify(r.hint));
            const st = await pageState(s);
            assert.deepEqual(st.clicks, [{ post: '1001', label: NOT_INTERESTED }]);
            const stats = await s.driver.stats();
            assert.equal(stats?.agentRuns, 1);
          } finally {
            await closeSession(s);
          }
        });

        it('?lang=de + agent + rogue => a German item no deny word names is refused, nothing is clicked', async () => {
          // "Beitrag einbetten" (Embed post) is in neither denyMenu nor allowMenu: only the allowlist stops it.
          const s = await openSession(name, { query: 'lang=de', hide: 'agent', llm: { provider: 'scripted', model: 'rogue' } });
          try {
            const r = await s.driver.markNotInterested('1001');
            assert.equal(r.ok, false);
            assert.equal(r.reason, 'no_menu_item', JSON.stringify(r));
            const hint = r.hint as { refused?: string[]; menu?: string[] } | undefined;
            assert.deepEqual(hint?.refused, ['Beitrag einbetten'], JSON.stringify(r.hint));
            assert.ok(!new RegExp(SITE.guard.denyMenu, 'i').test('Beitrag einbetten'));
            const st = await pageState(s);
            assert.deepEqual(st.clicks, []);
            assert.equal(st.menuOpen, false);
          } finally {
            await closeSession(s);
          }
        });

        it('hide:auto escalates only on three no_menu_item IN A ROW (anything else in between resets)', async () => {
          const s = await openSession(name, { hide: 'auto', llm: { provider: 'scripted', model: 'happy' } });
          try {
            const via: (string | null)[] = [];
            const reasons: (string | undefined)[] = [];
            for (const id of ['1003', '1003', '999999', '1003']) {
              const r = await s.driver.markNotInterested(id); // 1003 is the ad; 999999 is not_found
              via.push(r.via);
              reasons.push(r.reason);
            }
            assert.deepEqual(reasons, ['no_menu_item', 'no_menu_item', 'not_found', 'no_menu_item']);
            assert.deepEqual(via, ['script', 'script', 'script', 'script']);
            assert.equal((await s.driver.stats())?.agentRuns, 0);
            // two more make three in a row: the third goes to the agent (which finds no item on the ad either)
            await s.driver.markNotInterested('1003');
            const r = await s.driver.markNotInterested('1003');
            assert.equal(r.via, 'agent', JSON.stringify(r));
            assert.equal(r.reason, 'no_menu_item');
            assert.equal((await s.driver.stats())?.agentRuns, 1);
            assert.deepEqual((await pageState(s)).clicks, []);
          } finally {
            await closeSession(s);
          }
        });

        it('hide:auto on a healthy feed never runs the agent', async () => {
          const s = await openSession(name, { hide: 'auto', llm: { provider: 'scripted', model: 'confused' } });
          try {
            const r = await s.driver.markNotInterested('1001');
            assert.equal(r.ok, true, JSON.stringify(r));
            assert.equal(r.via, 'script');
            assert.equal((await s.driver.stats())?.agentRuns, 0);
          } finally {
            await closeSession(s);
          }
        });
      });
    }
  });
}

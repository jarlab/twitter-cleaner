// Every in-page function (site/x.inpage.js) against the fake X feed, through inPageExpr: the exact
// string both drivers evaluate. Also the guard regexes from site/x.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { inPageExpr, SITE, siteBundle } from '../src/site/index.js';

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/fake_x.html'), 'utf8');
const ORIGIN = 'http://fixture.test'; // never hits the network: page.route serves the fixture

let browser: Browser;
let page: Page;

async function load(query = ''): Promise<void> {
  await page.goto(`${ORIGIN}/home${query}`);
}

async function call<T = any>(name: string, extra?: Record<string, unknown>): Promise<T> {
  return JSON.parse((await page.evaluate(inPageExpr(name, extra))) as string);
}

// Attribute stamps as the page sees them, e.g. which post carries data-tc-target.
function stampedIds(attr: string): Promise<string[]> {
  return page.evaluate(
    (a) => [...document.querySelectorAll(`[${a}]`)].map((e) => e.querySelector('time')?.closest('a')?.getAttribute('href') ?? e.tagName),
    attr,
  );
}

before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.route(`${ORIGIN}/**`, (route) =>
    route.request().url().includes('/home')
      ? route.fulfill({ contentType: 'text/html', body: FIXTURE })
      : route.fulfill({ status: 404, body: '' }),
  );
});
afterEach(async () => {
  await page?.close();
});

describe('site bundle', () => {
  it('inPageExpr is one JSON-returning expression over x.json', async () => {
    assert.match(inPageExpr('isLoggedIn'), /^JSON\.stringify\(\(/);
    assert.equal(siteBundle({ homeUrl: 'http://127.0.0.1:1/home' }).site.homeUrl, 'http://127.0.0.1:1/home');
    assert.equal(siteBundle().site.sel.article, SITE.sel.article);
    assert.ok(siteBundle().inpage.includes('postButtons('));
  });
});

describe('session', () => {
  it('isLoggedIn / myHandle', async () => {
    await load();
    assert.equal(await call('isLoggedIn'), true);
    assert.deepEqual(await call('myHandle'), { handle: 'me' });
  });

  it('logged out until the human clicks "Log in"', async () => {
    await load('?logged_out=1');
    assert.equal(await call('isLoggedIn'), false);
    assert.deepEqual(await call('myHandle'), { handle: null });
    await page.click('#login');
    assert.equal(await call('isLoggedIn'), true);
  });

  it('forYouTab stamps the tab, then reports it selected', async () => {
    await load();
    assert.deepEqual(await call('forYouTab'), { state: 'stamped' });
    assert.equal(await page.locator('[data-tc-tab]').innerText(), 'For you');
    await page.locator('[data-tc-tab]').click();
    assert.deepEqual(await call('forYouTab'), { state: 'selected' });
  });

  it('forYouTab reports a missing tab', async () => {
    await load();
    await page.evaluate(() => document.getElementById('header')!.remove());
    assert.deepEqual(await call('forYouTab'), { state: 'missing' });
  });
});

describe('scan', () => {
  it('reads every mounted post in feed order without stamping', async () => {
    await load();
    const { posts, stamped } = await call('scan');
    assert.equal(stamped, false);
    assert.deepEqual(
      posts.map((p: any) => p.id),
      ['1000', '1001', '1002', '1003', '1004', '1005'],
    );
    for (const p of posts) assert.deepEqual(Object.keys(p).sort(), ['author', 'id', 'quoted', 'text']);
    const byId = Object.fromEntries(posts.map((p: any) => [p.id, p]));
    assert.equal(byId['1002'].quoted, 'Quoted text from zed');
    assert.equal(byId['1002'].author, 'carol');
    assert.equal(byId['1001'].quoted, null);
    assert.equal(byId['1004'].author, 'Me');
    assert.equal(byId['1005'].text, '');
    assert.match(byId['1000'].text, /^Post 1000 by alice/);
    assert.deepEqual(await stampedIds('data-tc-target'), []);
  });

  it('target stamps exactly that post and its cell', async () => {
    await load();
    assert.equal((await call('scan', { target: '1002' })).stamped, true);
    assert.deepEqual(await stampedIds('data-tc-target'), ['/carol/status/1002']);
    assert.equal(await page.locator('[data-tc-cell] [data-tc-target]').count(), 1);
    // retargeting moves the stamp
    await call('scan', { target: '1001' });
    assert.deepEqual(await stampedIds('data-tc-target'), ['/bob/status/1001']);
  });

  it('a quoted post id never stamps the outer post', async () => {
    await load();
    const r = await call('scan', { target: '91002' });
    assert.equal(r.stamped, false);
    assert.ok(!r.posts.some((p: any) => p.id === '91002'));
    assert.equal(await page.locator('[data-tc-target]').count(), 0);
  });

  it('an unknown id stamps nothing and clears old stamps', async () => {
    await load();
    await call('scan', { target: '1000' });
    assert.equal((await call('scan', { target: 'nope' })).stamped, false);
    assert.equal(await page.locator('[data-tc-target],[data-tc-cell]').count(), 0);
  });
});

describe('focus', () => {
  it('puts the post under the sticky header and outlines it', async () => {
    await load();
    assert.deepEqual(await call('focus', { target: '1001' }), { found: true });
    const { y, top, header, outline } = await page.evaluate(() => {
      const el = document.querySelector('[data-tc-focus]') as HTMLElement;
      return {
        y: window.scrollY,
        top: el.getBoundingClientRect().top,
        header: document.getElementById('header')!.getBoundingClientRect().bottom,
        outline: el.style.outline,
      };
    });
    assert.ok(y > 0, `scrollY ${y}`);
    assert.ok(top >= header && top <= header + 20, `top ${top}, header bottom ${header}`);
    assert.match(outline, /solid/);
    assert.deepEqual(await stampedIds('data-tc-focus'), ['/bob/status/1001']);
  });

  it('moves the outline to the next post, and returns found:false for unknown ids', async () => {
    await load();
    await call('focus', { target: '1000' });
    await call('focus', { target: '1001' });
    assert.deepEqual(await stampedIds('data-tc-focus'), ['/bob/status/1001']);
    assert.deepEqual(await call('focus', { target: 'nope' }), { found: false });
    assert.equal(await page.locator('[data-tc-focus]').count(), 0);
  });
});

describe('menu and hideState', () => {
  async function openMenu(id: string) {
    await call('scan', { target: id });
    await page.locator(`[data-tc-target] ${SITE.sel.caret}`).click();
  }

  it('closed menu', async () => {
    await load();
    assert.deepEqual(await call('menu'), { open: false, labels: [], stamped: false, choice: null });
  });

  it('stamps "Not interested" on a normal post, then the post is hidden after the click', async () => {
    await load();
    await openMenu('1001');
    const m = await call('menu');
    assert.equal(m.open, true);
    assert.equal(m.stamped, true);
    assert.equal(m.choice, 'Not interested in this post');
    assert.ok(m.labels.includes('Block @bob'));
    assert.deepEqual(await call('hideState', { target: '1001' }), { state: 'visible' });
    await page.locator('[data-tc-choice]').click();
    await page.waitForTimeout(300); // the fixture swaps in the notice after 150 ms
    assert.deepEqual(await call('hideState', { target: '1001' }), { state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => (window as any).__clicks), [
      { post: '1001', label: 'Not interested in this post' },
    ]);
  });

  it('an ad has no "Not interested" item: nothing is stamped', async () => {
    await load();
    await openMenu('1003');
    const m = await call('menu');
    assert.deepEqual(m, { open: true, labels: ['Why this ad?', 'Report ad'], stamped: false, choice: null });
    assert.equal(await page.locator('[data-tc-choice]').count(), 0);
  });

  it('an exact label can be stamped instead', async () => {
    await load();
    await openMenu('1000');
    assert.equal((await call('menu', { label: 'Mute @alice' })).choice, 'Mute @alice');
    assert.equal(await page.locator('[data-tc-choice]').innerText(), 'Mute @alice');
    assert.equal((await call('menu', { label: 'Not there' })).stamped, false);
  });

  it('hideState is "gone" when the post unmounts without a notice', async () => {
    await load();
    await call('scan', { target: '1000' });
    await page.evaluate(() => document.querySelector('[data-tc-cell]')!.remove());
    assert.deepEqual(await call('hideState', { target: '1000' }), { state: 'gone' });
  });
});

describe('guard', () => {
  const deny = new RegExp(SITE.guard.denyMenu, 'i');

  it('denies dangerous menu items', () => {
    for (const label of ['Mute @x', 'Block @x', 'Report post', 'Folgen @x', 'Follow @x', 'Unfollow @x', 'Delete', 'Add/remove @x from Lists']) {
      assert.ok(deny.test(label), label);
    }
  });

  it('allows "not interested" wordings', () => {
    for (const label of ['Not interested in this post', 'Show fewer posts like this', "This post isn't relevant"]) {
      assert.ok(!deny.test(label), label);
    }
  });

  // hide_agent.py's choose_menu_item rule: an allowlist, then the deny words and "@" on top.
  const allow = new RegExp(SITE.guard.allowMenu, 'i');
  const agentMayChoose = (label: string) => !label.includes('@') && !deny.test(label) && allow.test(label);
  const LOCALIZED_OK = [
    'Not interested in this post', 'Show fewer posts like this', "This post isn't relevant", 'This post isn’t relevant',
    'Nicht interessiert an diesem Beitrag', 'Kein Interesse an diesem Post', 'No me interesa este post',
    'Pas intéressé par ce post', 'Non mi interessa questo post', 'Não tenho interesse neste post',
    'Niet geïnteresseerd in deze post', 'このポストに興味がない',
  ];
  const LOCALIZED_BAD = [
    'Report post', 'Mute @x', 'Why this ad?', 'Embed post', 'View post engagements', 'Hide this forever please',
    'Beitrag melden', 'Diese Konversation stummschalten', '@alice folgen', '@alice blockieren',
    'Denunciar post', 'Silenciar esta conversación', 'Signaler le post', 'Segnala post', 'Пожаловаться на пост',
  ];

  it('the agent may choose "not interested" wordings, in several languages', () => {
    for (const label of LOCALIZED_OK) assert.ok(agentMayChoose(label), label);
  });

  it('the agent may choose nothing else, also in languages the deny words do not cover', () => {
    for (const label of LOCALIZED_BAD) assert.ok(!agentMayChoose(label), label);
    assert.ok(!deny.test('Пожаловаться на пост') && !allow.test('Пожаловаться на пост'), 'only the allowlist stops this one');
  });

  it('postButtons offers only the target\'s safe buttons (no Like/Repost/Reply/Bookmark/Share/Grok)', async () => {
    await load();
    assert.deepEqual(await call('postButtons'), []); // nothing stamped yet
    await call('scan', { target: '1002' }); // the quote post: its quoted block is a link, never offered
    const buttons = await call<{ n: number; label: string }[]>('postButtons');
    assert.deepEqual(buttons, [{ n: 0, label: 'More' }]);
    const stamped = await page.locator('[data-tc-btn]').evaluateAll((els) =>
      els.map((e) => [e.getAttribute('data-tc-btn'), e.getAttribute('aria-label'), !!e.closest('[data-tc-target]')]),
    );
    assert.deepEqual(stamped, [['0', 'More', true]]);
    for (const bad of [/like/i, /repost/i, /reply/i, /bookmark/i, /share/i, /grok/i]) {
      assert.ok(!buttons.some((b) => bad.test(b.label)), String(bad));
    }
  });
});

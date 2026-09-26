// FeedDriver on Playwright, in-process. Every DOM read goes through the shared in-page functions
// (site/x.inpage.js), which stamp data-tc-* attributes; the native clicks then target those stamps.
// Nothing is held across awaits: each action re-finds its post by id right before clicking, because
// X re-renders the feed at will and a remembered element may by then be a different post.
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Config } from '../config.js';
import { inPageExpr, SITE } from '../site/index.js';
import type { DriverStats, FailReason, FeedDriver, HideResult, Post, SiteConfig } from './types.js';

export type PlaywrightOptions = Config['playwright'] & { smoothScroll?: boolean };

type MenuState = { open: boolean; labels: string[]; stamped: boolean; choice: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PlaywrightDriver implements FeedDriver {
  readonly name = 'playwright' as const;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly site: SiteConfig;

  constructor(private readonly cfg: PlaywrightOptions) {
    this.site = cfg.homeUrl ? { ...SITE, homeUrl: cfg.homeUrl } : SITE;
  }

  async open({ onPrompt }: { onPrompt: (msg: string) => void }): Promise<{ handle: string | null }> {
    const { sel } = this.site;
    // handleSIGINT: false, so Ctrl-C is ours (stop after the current post) rather than Playwright's.
    this.context = await chromium.launchPersistentContext(this.cfg.profileDir, {
      headless: this.cfg.headless,
      viewport: this.cfg.viewport,
      handleSIGINT: false,
    });
    const page = (this.page = this.context.pages()[0] ?? (await this.context.newPage()));
    await page.goto(this.site.homeUrl);

    // X renders slowly: give the account switcher a real chance before deciding we're logged out.
    if (!(await this.poll(() => this.call<boolean>('isLoggedIn'), Boolean, 8000))) {
      onPrompt(this.site.text.loginPrompt);
      await this.poll(() => this.call<boolean>('isLoggedIn'), Boolean, Infinity, 1000);
    }

    // "Not interested" only exists on the algorithmic "For you" tab.
    const tab = await this.poll(() => this.call<{ state: string }>('forYouTab'), (t) => t.state !== 'missing', 10_000);
    if (!tab) throw new Error('could not find the "For you" tab (see text.forYou in src/site/x.json)');
    if (tab.state === 'stamped') await page.locator('[data-tc-tab]').click();

    await page.locator(sel.article).first().waitFor({ timeout: 30_000 });
    return this.call<{ handle: string | null }>('myHandle');
  }

  async readVisiblePosts(): Promise<Post[]> {
    return (await this.call<{ posts: Post[] }>('scan')).posts;
  }

  async focus(id: string): Promise<boolean> {
    const smooth = this.cfg.smoothScroll ?? true;
    const { found } = await this.call<{ found: boolean }>('focus', { target: id, smooth });
    if (found) await sleep(smooth ? 450 : 100); // let the scroll finish so you can see it
    return found;
  }

  async scroll(): Promise<void> {
    const height = this.page!.viewportSize()?.height ?? this.cfg.viewport.height;
    await this.page!.mouse.wheel(0, Math.round(height * 0.9));
    await sleep(this.cfg.settleMs);
  }

  async markNotInterested(id: string, { commit = true }: { commit?: boolean } = {}): Promise<HideResult> {
    const page = this.page!;
    const fail = (reason: FailReason, extra: Partial<HideResult> = {}): HideResult => ({ ok: false, via: 'script', reason, ...extra });
    try {
      await this.closeMenu();
      if (!(await this.stamp(id))) return fail('not_found');
      const caret = page.locator(`[data-tc-target] ${this.site.sel.caret}`).first();
      if ((await caret.count()) === 0) return fail('caret_missing');
      if (!(await this.clickTarget(caret, id))) return fail('not_found');

      const menu = await this.poll(() => this.call<MenuState>('menu'), (m) => m.open, this.cfg.menuTimeoutMs);
      if (!menu) return fail('menu_not_opened');
      if (!menu.stamped) return fail('no_menu_item', { detail: `menu: ${menu.labels.join(' | ')}` });
      if (!commit) return { ok: true, via: 'script', rehearsed: true, label: menu.choice };

      await page.locator('[data-tc-choice]').first().click({ timeout: 3000 });
      const gone = await this.poll(
        () => this.call<{ state: string }>('hideState', { target: id }),
        (h) => h.state !== 'visible',
        3000,
      );
      return gone ? { ok: true, via: 'script', label: menu.choice } : fail('unverified', { label: menu.choice });
    } catch (err) {
      return fail('error', { detail: (err as Error).message.split('\n')[0] });
    } finally {
      await this.closeMenu().catch(() => {});
    }
  }

  async stats(): Promise<DriverStats | null> {
    return null; // no LLM on this driver
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = this.page = null;
    await context?.close().catch(() => {});
  }

  // ---------------------------------------------------------------- helpers

  /** Runs one in-page function (see site/x.inpage.js) and returns its parsed result. */
  private async call<T>(name: string, extra?: Record<string, unknown>): Promise<T> {
    if (!this.page) throw new Error('driver is not open');
    return JSON.parse((await this.page.evaluate(inPageExpr(name, extra, this.site))) as string) as T;
  }

  /** Stamps post `id` (data-tc-target) and its feed cell; false if it isn't mounted. */
  private async stamp(id: string): Promise<boolean> {
    return (await this.call<{ stamped: boolean }>('scan', { target: id })).stamped;
  }

  /**
   * Clicks an element inside the stamped post. If X re-rendered in between, the stamp is gone with
   * the old node and the click times out: re-stamp by id once and retry. False if the post vanished.
   */
  private async clickTarget(el: Locator, id: string): Promise<boolean> {
    try {
      await el.click({ timeout: 3000 });
      return true;
    } catch {
      if (!(await this.stamp(id))) return false;
      await el.click({ timeout: 3000 });
      return true;
    }
  }

  /** Escape, but only when a menu is open (Escape elsewhere can close other X dialogs). */
  private async closeMenu(): Promise<void> {
    if (!this.page || !(await this.call<MenuState>('menu')).open) return;
    await this.page.keyboard.press('Escape');
    await this.poll(() => this.call<MenuState>('menu'), (m) => !m.open, 1000, 100);
  }

  /**
   * Calls `read` until `done(value)` or the timeout; null on timeout. Errors count as "not yet"
   * (a navigation, e.g. while you log in, destroys the page's JS context for a moment).
   */
  private async poll<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, everyMs = 200): Promise<T | null> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (!this.page || this.page.isClosed()) throw new Error('the browser window was closed');
      try {
        const v = await read();
        if (done(v)) return v;
      } catch {
        // not ready yet
      }
      if (Date.now() >= until) return null;
      await sleep(everyMs);
    }
  }
}

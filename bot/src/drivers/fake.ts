// A scripted feed for tests: no browser. Each readVisiblePosts() returns the current "screen";
// scroll() moves to the next one. Every call is recorded in `calls` so tests can check the order.
import type { DriverStats, FeedDriver, HideResult, Post } from './types.js';

export type FakeCall =
  | { op: 'open' }
  | { op: 'read' }
  | { op: 'focus'; id: string }
  | { op: 'scroll' }
  | { op: 'hide'; id: string; commit: boolean }
  | { op: 'stats' }
  | { op: 'close' };

export type FakeOptions = {
  screens: Post[][]; // what each successive screen shows (the last one repeats after the end)
  handle?: string | null; // logged-in handle (default 'me')
  hide?: (id: string, commit: boolean) => HideResult | Promise<HideResult>; // default: always works
  stats?: DriverStats | null;
};

export class FakeDriver implements FeedDriver {
  readonly name = 'fake' as const;
  readonly calls: FakeCall[] = [];
  private screen = 0;

  constructor(private o: FakeOptions) {}

  async open(): Promise<{ handle: string | null }> {
    this.calls.push({ op: 'open' });
    return { handle: this.o.handle === undefined ? 'me' : this.o.handle };
  }

  async readVisiblePosts(): Promise<Post[]> {
    this.calls.push({ op: 'read' });
    return this.o.screens[Math.min(this.screen, this.o.screens.length - 1)] ?? [];
  }

  async focus(id: string): Promise<boolean> {
    this.calls.push({ op: 'focus', id });
    return true;
  }

  async scroll(): Promise<void> {
    this.calls.push({ op: 'scroll' });
    this.screen++;
  }

  async markNotInterested(id: string, o: { commit?: boolean } = {}): Promise<HideResult> {
    const commit = o.commit ?? true;
    this.calls.push({ op: 'hide', id, commit });
    if (this.o.hide) return this.o.hide(id, commit);
    return commit
      ? { ok: true, via: 'script', label: 'Not interested in this post' }
      : { ok: true, via: 'script', rehearsed: true, label: 'Not interested in this post' };
  }

  async stats(): Promise<DriverStats | null> {
    this.calls.push({ op: 'stats' });
    return this.o.stats ?? null;
  }

  async close(): Promise<void> {
    this.calls.push({ op: 'close' });
  }

  /** Just the calls of one kind, e.g. fake.ops('focus'). */
  ops<K extends FakeCall['op']>(op: K): Extract<FakeCall, { op: K }>[] {
    return this.calls.filter((c): c is Extract<FakeCall, { op: K }> => c.op === op);
  }
}

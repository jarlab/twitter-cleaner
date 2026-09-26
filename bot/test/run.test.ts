// The loop's policy, against FakeDriver: no browser, fake clock.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeDriver, type FakeOptions } from '../src/drivers/fake.js';
import type { HideResult, Post } from '../src/drivers/types.js';
import type { DecisionV2 } from '../src/log.js';
import { run, type RunOptions } from '../src/run.js';

const post = (id: string, author = 'alice', text = `post ${id}`): Post => ({ id, author, text, quoted: null });
const posts = (...ids: string[]) => ids.map((id) => post(id));

const OPTS: RunOptions = {
  limit: 50,
  minDelay: 0,
  maxDelay: 0,
  maxIdleScrolls: 2,
  dryRun: false,
  rehearse: false,
  classifierVersion: 7,
  hideMode: null,
  llm: null,
};

// Runs the loop with fakes. `hideIds` decides which posts the "classifier" flags (default: all).
async function go(
  fake: FakeOptions,
  opts: Partial<RunOptions> = {},
  o: {
    hideIds?: string[];
    classify?: (p: Post, tick: (ms: number) => void) => Promise<void>; // tick advances the fake clock
    stopAfter?: number;
    random?: number;
  } = {},
) {
  const driver = new FakeDriver(fake);
  const lines: string[] = [];
  const rows: DecisionV2[] = [];
  const classified: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const result = await run(
    {
      driver,
      classify: async (p) => {
        classified.push(p.id);
        await o.classify?.(p, (ms) => (clock += ms));
        const flagged = o.hideIds ? o.hideIds.includes(p.id) : true;
        return { model: 'jev-test', answers: { flag: { type: 'noul', noul: flagged ? 1 : 0 } } };
      },
      shouldHide: (answers) => (answers.flag as { noul: number }).noul === 1,
      log: (d) => rows.push(d),
      onLine: (l) => lines.push(l),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      shouldStop: () => o.stopAfter !== undefined && classified.length >= o.stopAfter,
      random: () => o.random ?? 0,
    },
    { ...OPTS, ...opts },
  );
  return { driver, lines, rows, classified, sleeps, result };
}

describe('run', () => {
  it('dry run classifies and logs but never acts', async () => {
    const { driver, rows, lines, result } = await go({ screens: [posts('1', '2')] }, { dryRun: true });
    assert.equal(driver.ops('hide').length, 0);
    assert.equal(result.classified, 2);
    assert.equal(result.hidden, 0);
    assert.deepEqual(rows.map((r) => [r.hide, r.acted, r.dry_run, r.via]), [
      [true, false, true, null],
      [true, false, true, null],
    ]);
    assert.ok(lines.some((l) => l.startsWith('DRY   @alice')));
  });

  it('rehearse passes commit:false and counts nothing as hidden', async () => {
    const { driver, rows, lines, result } = await go({ screens: [posts('1', '2')] }, { rehearse: true });
    assert.deepEqual(driver.ops('hide').map((h) => h.commit), [false, false]);
    assert.equal(result.hidden, 0);
    assert.deepEqual(rows.map((r) => [r.acted, r.rehearse, r.menu_label]), [
      [false, true, 'Not interested in this post'],
      [false, true, 'Not interested in this post'],
    ]);
    assert.ok(lines.some((l) => l.startsWith('TRY ')));
  });

  it('focuses every post in feed order, including skipped ones', async () => {
    const screen = [post('1'), post('2', 'Me'), post('3', 'bob', '  '), post('4')];
    const { driver } = await go({ screens: [screen] });
    assert.deepEqual(driver.ops('focus').map((f) => f.id), ['1', '2', '3', '4']);
  });

  it('skips own posts (case-insensitive) and media-only posts without counting or logging them', async () => {
    const screen = [post('1'), post('2', 'ME'), post('3', 'bob', ''), post('4')];
    const { classified, rows, result } = await go({ screens: [screen], handle: 'me' });
    assert.deepEqual(classified, ['1', '4']);
    assert.deepEqual(rows.map((r) => r.post_id), ['1', '4']);
    assert.equal(result.classified, 2);
  });

  it('warns and keeps own posts when the handle is unknown', async () => {
    const { classified, lines } = await go({ screens: [[post('1', 'me')]], handle: null });
    assert.deepEqual(classified, ['1']);
    assert.ok(lines.some((l) => l.includes('handle')));
  });

  it('stops at the limit', async () => {
    const { driver, classified, result } = await go({ screens: [posts('1', '2', '3', '4')] }, { limit: 2 });
    assert.deepEqual(classified, ['1', '2']);
    assert.equal(result.classified, 2);
    assert.deepEqual(driver.ops('focus').map((f) => f.id), ['1', '2']);
  });

  it('handles each post once across overlapping screens', async () => {
    const { classified, driver } = await go({ screens: [posts('1', '2'), posts('2', '3'), posts('3', '4')] });
    assert.deepEqual(classified, ['1', '2', '3', '4']);
    assert.deepEqual(driver.ops('focus').map((f) => f.id), ['1', '2', '3', '4']);
  });

  it('stops after maxIdleScrolls scrolls in a row with nothing new', async () => {
    const { driver, result } = await go({ screens: [posts('1')] }, { maxIdleScrolls: 3 });
    assert.equal(result.classified, 1);
    assert.equal(driver.ops('scroll').length, 3);
    assert.equal(result.error, null);
  });

  it('a new screen resets the idle count', async () => {
    // Each new post shows up after 2 empty scrolls; without the reset, 4 idle scrolls would stop it.
    const screens = [posts('1'), posts('1'), posts('2'), posts('2'), posts('3')];
    const { driver, classified } = await go({ screens }, { maxIdleScrolls: 3 });
    assert.deepEqual(classified, ['1', '2', '3']);
    assert.equal(driver.ops('scroll').length, 2 + 2 + 3);
  });

  it('only hides what the classifier flags', async () => {
    const { driver, rows, lines, result } = await go({ screens: [posts('1', '2', '3')] }, {}, { hideIds: ['2'] });
    assert.deepEqual(driver.ops('hide').map((h) => [h.id, h.commit]), [['2', true]]);
    assert.equal(result.hidden, 1);
    assert.deepEqual(rows.map((r) => [r.hide, r.acted, r.via]), [
      [false, false, null],
      [true, true, 'script'],
      [false, false, null],
    ]);
    assert.ok(lines[0]!.startsWith('keep  @alice: post 1'));
    assert.ok(lines[1]!.startsWith('HIDE  @alice: post 2'));
  });

  it('stops at once on a fatal result (wrong_post)', async () => {
    const hide = (): HideResult => ({ ok: false, via: 'agent', reason: 'wrong_post', fatal: true, detail: 'post 9 vanished' });
    const { driver, rows, result } = await go({ screens: [posts('1', '2', '3')], hide });
    assert.equal(driver.ops('hide').length, 1);
    assert.equal(result.classified, 1);
    assert.match(result.error ?? '', /wrong_post/);
    assert.equal(rows[0]!.fail_reason, 'wrong_post');
  });

  it('a throwing driver counts as a fatal error', async () => {
    const hide = (): HideResult => {
      throw new Error('boom');
    };
    const { rows, result } = await go({ screens: [posts('1', '2')], hide });
    assert.equal(result.classified, 1);
    assert.match(result.error ?? '', /boom/);
    assert.deepEqual([rows[0]!.fail_reason, rows[0]!.via, rows[0]!.acted], ['error', null, false]);
  });

  it('stops after 3 non-benign failures in a row', async () => {
    const hide = (): HideResult => ({ ok: false, via: 'script', reason: 'caret_missing' });
    const { driver, lines, result } = await go({ screens: [posts('1', '2', '3', '4', '5')], hide });
    assert.equal(driver.ops('hide').length, 3);
    assert.match(result.error ?? '', /3 failed hides in a row/);
    assert.ok(lines.some((l) => l.startsWith('FAIL(caret_missing)')));
  });

  it('a used-up agent budget stops the run at once, and is not blamed on the markup', async () => {
    const results: HideResult[] = [
      { ok: true, via: 'agent', label: 'Not interested in this post' },
      { ok: false, via: null, reason: 'budget', detail: '20 agent runs, $0.0000 spent' },
    ];
    let i = 0;
    const { driver, rows, lines, result } = await go({ screens: [posts('1', '2', '3', '4', '5')], hide: () => results[i++]! });
    assert.equal(driver.ops('hide').length, 2);
    assert.equal(result.hidden, 1);
    assert.match(result.error ?? '', /agent budget is used up \(20 agent runs, \$0\.0000 spent\)/);
    assert.match(result.error ?? '', /maxAgentRuns \/ maxUsd in src\/config\.ts/);
    assert.doesNotMatch(result.error ?? '', /markup/);
    assert.deepEqual(rows.map((r) => r.fail_reason), [null, 'budget']); // the refused post is still logged
    assert.ok(lines.some((l) => l.startsWith('FAIL(budget)')));
  });

  it('benign failures and successes reset the strike count', async () => {
    const results: HideResult[] = [
      { ok: false, via: 'script', reason: 'unverified' },
      { ok: false, via: 'script', reason: 'menu_not_opened' },
      { ok: false, via: 'script', reason: 'not_found' },
      { ok: false, via: 'script', reason: 'unverified' },
      { ok: false, via: 'script', reason: 'unverified' },
      { ok: false, via: 'script', reason: 'no_menu_item' },
      { ok: false, via: 'script', reason: 'unverified' },
      { ok: false, via: 'script', reason: 'unverified' },
      { ok: true, via: 'script', label: 'Not interested in this post' },
      { ok: false, via: 'script', reason: 'unverified' },
    ];
    let i = 0;
    const ids = results.map((_, n) => String(n + 1));
    const { result } = await go({ screens: [posts(...ids)], hide: () => results[i++]! });
    assert.equal(result.error, null);
    assert.equal(result.classified, results.length);
    assert.equal(result.hidden, 1);
  });

  it('a classify failure is reported and skipped, not counted', async () => {
    const { classified, rows, lines, result } = await go(
      { screens: [posts('1', '2')] },
      {},
      {
        classify: async (p) => {
          if (p.id === '1') throw new Error('rate limited');
        },
      },
    );
    assert.deepEqual(classified, ['1', '2']);
    assert.equal(result.classified, 1);
    assert.deepEqual(rows.map((r) => r.post_id), ['2']);
    assert.ok(lines.some((l) => l.includes('classify failed for 1: rate limited')));
  });

  it('Ctrl-C (shouldStop) ends the run after the current post', async () => {
    const { classified, result } = await go({ screens: [posts('1', '2', '3')] }, {}, { stopAfter: 1 });
    assert.deepEqual(classified, ['1']);
    assert.equal(result.classified, 1);
  });

  it('pacing: the pause is the reading time minus the time already spent on the post', async () => {
    // random 0.5 => reading time 2000 ms. Post 1 took 300 ms, post 2 took 2500 ms, post 3 is the last.
    const { sleeps } = await go(
      { screens: [posts('1', '2', '3')] },
      { minDelay: 1000, maxDelay: 3000, limit: 3 },
      { random: 0.5, classify: async (p, tick) => tick(p.id === '2' ? 2500 : 300) },
    );
    assert.deepEqual(sleeps, [1700]);
  });

  it('pacing: no pause after skipped posts', async () => {
    const { sleeps } = await go(
      { screens: [[post('1'), post('2', 'me'), post('3', 'bob', ''), post('4')]] },
      { minDelay: 1000, maxDelay: 1000 },
    );
    assert.deepEqual(sleeps, [1000, 1000]); // after 1 and 4 (the limit is not reached, so 4 gets one too)
  });

  it('log rows are DecisionV2 with exactly the documented keys', async () => {
    const hide = (): HideResult => ({ ok: true, via: 'agent', label: 'Show fewer posts like this', costUsd: 0.0123 });
    const { rows, lines } = await go(
      { screens: [[{ id: '42', author: 'bob', text: 'hello', quoted: 'q' }]], hide },
      { hideMode: 'auto', llm: 'ollama:qwen3:8b' },
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual(Object.keys(row).sort(), [
      'acted', 'agent_cost_usd', 'answers', 'at', 'author', 'classifier_version', 'driver', 'dry_run',
      'fail_reason', 'hide', 'hide_mode', 'llm', 'menu_label', 'model', 'post_id', 'quoted', 'rehearse',
      'text', 'v', 'via',
    ]);
    assert.deepEqual(
      { ...row, at: undefined, answers: undefined },
      {
        v: 2, at: undefined, post_id: '42', author: 'bob', text: 'hello', quoted: 'q', classifier_version: 7,
        model: 'jev-test', answers: undefined, hide: true, acted: true, dry_run: false, rehearse: false,
        driver: 'fake', hide_mode: 'auto', llm: 'ollama:qwen3:8b', via: 'agent', fail_reason: null,
        menu_label: 'Show fewer posts like this', agent_cost_usd: 0.0123,
      },
    );
    assert.ok(!Number.isNaN(Date.parse(row.at)));
    assert.ok(lines[0]!.startsWith('HIDE  @bob: hello [$0.0123]'));
  });

  it('returns the driver stats', async () => {
    const { result } = await go({ screens: [posts('1')], stats: { agentRuns: 2, costUsd: 0.5 } });
    assert.deepEqual(result.stats, { agentRuns: 2, costUsd: 0.5 });
  });
});

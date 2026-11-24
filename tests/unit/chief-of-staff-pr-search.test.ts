import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicPrWarmupBudget, PUBLIC_PR_WARMUP_BUDGET_FILE } from '../../src/core/PublicPrWarmupBudget.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, expect, it, vi } from 'vitest';
import { fetchGitHubGraphql, GitHubGraphqlResponseError } from '../../src/core/githubRuntime.js';
import { ChiefOfStaffPrSearch } from '../../src/core/ChiefOfStaffPrSearch.js';

const now = Date.parse('2026-11-24T03:00:00Z');

type Row = {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'MERGED';
  mergedAt: string | null;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
};

function row(number: number, overrides: Partial<Row> = {}): Row {
  return {
    number,
    title: `Feature ${number}`,
    body: '',
    state: 'OPEN' as const,
    mergedAt: null,
    updatedAt: new Date(now).toISOString(),
    headRefName: `topic/change-${number}`,
    baseRefName: 'main',
    ...overrides,
  };
}

function page(nodes: ReturnType<typeof row>[], next: string | null = null) {
  return { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } };
}

describe('Chief of Staff pull request lookup', () => {
  it('does not turn a required warm read into an on-demand refresh', async () => {
    const readToken = vi.fn(() => 'fixture');
    const fetchPage = vi.fn(async () => page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken, fetchPage });
    await expect(lookup.searchWarm('#3342')).rejects.toThrow('not ready');
    expect(readToken).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it('paces complete retained observations and drops both scopes on observed denial', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(now);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pr-pace-'));
    try {
      fs.mkdirSync(path.join(root, 'state'));
      fs.writeFileSync(path.join(root, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE),
        JSON.stringify({ version: 1, attempts: [], pages: [], outstanding: [], retryNotBefore: 0, lastObservedAt: 0 }));
      const budget = new PublicPrWarmupBudget(root, () => true);
      const enrollment = { enabled: () => true, budget, jitterMs: 0 };
      const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([row(3342)]) : page([]));
      const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, priorWarmBudget: budget });
      try {
        lookup.start(enrollment);
        lookup.start(enrollment);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchPage).toHaveBeenCalledTimes(2);
        expect((await lookup.search('#3342')).items).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect((await lookup.search('#3342')).coverage.open.status).toBe('stale');
        expect(fetchPage).toHaveBeenCalledTimes(2);

        let deny!: (error: Error) => void;
        const verifying = new Promise<never>((_resolve, reject) => { deny = reject; });
        fetchPage.mockImplementation(async () => verifying);
        await vi.advanceTimersByTimeAsync(360_000);
        expect(fetchPage).toHaveBeenCalledTimes(4);
        expect(await lookup.search('#3342')).toMatchObject({
          items: [{ number: 3342 }], coverage: { open: { status: 'stale' } },
        });
        deny(new GitHubGraphqlResponseError('public visibility withdrawn', 'authorization'));
        await vi.advanceTimersByTimeAsync(0);
        expect(await lookup.search('#3342')).toMatchObject({
          items: [], coverage: { open: { status: 'unavailable' }, merged: { status: 'unavailable' } },
        });
        lookup.stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetchPage).toHaveBeenCalledTimes(4);
      } finally {
        lookup.stop();
      }
    } finally {
      vi.useRealTimers();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'public-pr-pace-fixture' });
    }
  });

  it('retains reservations across reconstruction and refuses absent, rolled-back or exhausted budgets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pr-budget-'));
    try {
      let wall = now;
      const existing = () => new PublicPrWarmupBudget(root, () => true, () => wall);
      expect(existing().reserveAttempt()).toBe(false);
      fs.mkdirSync(path.join(root, 'state'));
      fs.writeFileSync(path.join(root, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE),
        JSON.stringify({ version: 1, attempts: [], pages: Array(299).fill(now), outstanding: [], retryNotBefore: 0, lastObservedAt: now }));
      const first = existing();
      for (let n = 0; n < 8; n++) expect(first.reserveAttempt()).toBe(true);
      const id = first.reservePage();
      expect(id).not.toBeNull();
      expect(first.settlePage(id!, 60_000)).toBe(true);
      const next = existing();
      expect(next.read()).toMatchObject({ retryNotBefore: now + 60_000, lastObservedAt: now });
      wall--;
      expect(next.reserveAttempt()).toBe(false);
      wall = now + 61_000;
      expect(next.reserveAttempt()).toBe(false);
      expect(next.reservePage()).toBeNull();
      wall = now + 3_600_001;
      expect(next.reserveAttempt()).toBe(true);
      expect(next.reservePage()).not.toBeNull();
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'public-pr-budget-fixture' });
    }
  });

  it('keeps the autonomous reservation floor after reconstructing the budget while allowing an explicit lookup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pr-autonomous-floor-'));
    try {
      let elapsed = 0;
      const makeBudget = () => new PublicPrWarmupBudget(root, () => true, () => now + elapsed);
      fs.mkdirSync(path.join(root, 'state'));
      fs.writeFileSync(path.join(root, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE),
        JSON.stringify({ version: 1, attempts: [], pages: [], outstanding: [], retryNotBefore: 0, lastObservedAt: 0 }));
      expect(makeBudget().reserveAttempt(true)).toBe(true);
      elapsed = 14_999;
      expect(makeBudget().reserveAttempt(true)).toBe(false);
      elapsed++;
      expect(makeBudget().reserveAttempt(true)).toBe(true);
      expect(makeBudget().reserveAttempt()).toBe(true);
      expect(makeBudget().reserveAttempt(true)).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'public-pr-autonomous-floor-fixture' });
    }
  });

  it('repairs a missing scope once without demand and never refills a lost budget after pause and restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(now);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pr-repair-'));
    const file = path.join(root, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE);
    const fetchPage = vi.fn(async (_token, state) => {
      if (state === 'MERGED') throw new Error('temporary provider failure');
      return page([row(3342)]);
    });
    const configuredBudget = () => new PublicPrWarmupBudget(root, () => true);
    const makeLookup = (budget?: PublicPrWarmupBudget) => new ChiefOfStaffPrSearch({
      readToken: () => 'fixture', fetchPage, priorWarmBudget: budget,
    });
    const budget = configuredBudget();
    const lookup = makeLookup(budget);
    try {
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify({ version: 1, attempts: [], pages: [], outstanding: [], retryNotBefore: 0, lastObservedAt: 0 }));
      let enabled = true;
      lookup.start({ enabled: () => enabled, budget, jitterMs: 30_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchPage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchPage).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(fetchPage).toHaveBeenCalledTimes(4);
      expect(await lookup.search('#3342', 'OPEN')).toMatchObject({ items: [{ number: 3342 }] });
      expect(fetchPage).toHaveBeenCalledTimes(4);

      const charged = budget.reservePage();
      expect(charged).not.toBeNull();
      expect(budget.settlePage(charged!, 120_000)).toBe(true);
      SafeFsExecutor.safeUnlinkSync(file, { operation: 'public-pr-warm-budget-loss-fixture' });
      enabled = false;
      await lookup.search('#3342');
      lookup.stop();
      expect(await makeLookup(configuredBudget()).search('#3342')).toMatchObject({ knownMatchCount: null });
      expect(fetchPage).toHaveBeenCalledTimes(4);
      await makeLookup().search('#3342');
      expect(fetchPage).toHaveBeenCalledTimes(6);
    } finally {
      lookup.stop();
      vi.useRealTimers();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'public-pr-repair-fixture' });
    }
  });

  it('charges paused lookups and holds an orphaned page after restart without resetting the floor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pr-orphan-'));
    try {
      const file = path.join(root, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE);
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify({
        version: 1, attempts: Array(7).fill(now), pages: [], outstanding: [],
        retryNotBefore: 0, lastObservedAt: now,
      }));
      let timestamp = now;
      const budget = () => new PublicPrWarmupBudget(root, () => true, () => timestamp);
      const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([row(3342)]) : page([]));
      const lookup = (priorWarmBudget: PublicPrWarmupBudget) => new ChiefOfStaffPrSearch({
        readToken: () => 'fixture', fetchPage, priorWarmBudget, now: () => timestamp,
      });
      const paused = lookup(budget());
      expect((await paused.search('#3342')).items).toHaveLength(1);
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(await lookup(budget()).search('#3342')).toMatchObject({ knownMatchCount: null });
      expect(fetchPage).toHaveBeenCalledTimes(2); // Eighth attempt survived pause and restart.

      timestamp += 3_600_001;
      const beforeCrash = budget();
      const inFlight = beforeCrash.reservePage();
      expect(inFlight).not.toBeNull();
      expect(budget().retryFloor()).toBe(Infinity);
      expect(await lookup(budget()).search('#3342')).toMatchObject({ knownMatchCount: null });
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(beforeCrash.settlePage(inFlight!, 60_000)).toBe(true);
      expect(budget().retryFloor()).toBe(timestamp + 60_000);
      expect(await lookup(budget()).search('#3342')).toMatchObject({ knownMatchCount: null });
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'public-pr-orphan-fixture' });
    }
  });

  it('waits for one superseded slot and joins a healthy successor without overlap', async () => {
    let token = 'first';
    let resolveOpen!: (value: ReturnType<typeof page>) => void;
    let resolveMerged!: (value: ReturnType<typeof page>) => void;
    const opened = new Promise<ReturnType<typeof page>>(resolve => { resolveOpen = resolve; });
    const merged = new Promise<ReturnType<typeof page>>(resolve => { resolveMerged = resolve; });
    const fetchPage = vi.fn(async (credential, state) => credential === 'first'
      ? state === 'OPEN' ? opened : merged
      : state === 'OPEN' ? page([row(6000)]) : page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => token, fetchPage });
    const original = lookup.search('#3342');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    token = 'second';

    const departing = new AbortController();
    const abandoned = lookup.search('#6000', undefined, 0, departing.signal);
    const replacement = lookup.search('#6000');
    const another = lookup.search('#6000');
    departing.abort();
    expect(await abandoned).toMatchObject({ knownMatchCount: null, items: [] });
    expect(fetchPage).toHaveBeenCalledTimes(2);

    resolveOpen(page([row(3342)]));
    resolveMerged(page([]));
    expect(await original).toMatchObject({ knownMatchCount: null, items: [] });
    for (const read of [replacement, another]) {
      expect(await read).toMatchObject({ knownMatchCount: 1, items: [{ number: 6000 }] });
    }
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it('restores baseline lookup on a stopped provider when the new lifecycle is paused or unselected', async () => {
    const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([row(3342)]) : page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage });
    lookup.stop();
    expect(await lookup.search('#3342')).toMatchObject({ knownMatchCount: null, items: [] });
    const neverOpened = new PublicPrWarmupBudget('/unused-dev-home', () => false);
    lookup.start({ enabled: () => false, budget: neverOpened, jitterMs: 0 });
    expect(lookup.isWarmEnrolled()).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(await lookup.search('#3342')).toMatchObject({ items: [{ number: 3342 }] });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    lookup.stop();
  });

  it('leaves an outstanding hold when the successful quota header cannot be settled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-pr-header-settle-'));
    try {
      fs.mkdirSync(path.join(root, 'state'));
      fs.writeFileSync(path.join(root, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE),
        JSON.stringify({ version: 1, attempts: [], pages: [], outstanding: [], retryNotBefore: 0, lastObservedAt: 0 }));
      const makeBudget = () => new PublicPrWarmupBudget(root, () => true);
      const budget = makeBudget();
      const settle = budget.settlePage.bind(budget);
      vi.spyOn(budget, 'settlePage').mockImplementation((id, wait) => wait > 0 ? false : settle(id, wait));
      const requestPage = vi.fn(async (_target: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const open = body.variables.states[0] === 'OPEN';
        const headers = open ? { 'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1_000) + 90) } : undefined;
        return new Response(JSON.stringify({
          data: { repository: { isPrivate: false, ...page(open ? [row(3342)] : []).repository } },
        }), { headers });
      });
      vi.stubGlobal('fetch', requestPage);
      const lookup = (priorWarmBudget: PublicPrWarmupBudget) => new ChiefOfStaffPrSearch({
        readToken: () => 'fixture', priorWarmBudget,
      });
      expect(await lookup(budget).search('#3342')).toMatchObject({ knownMatchCount: null, items: [] });
      expect(budget.settlePage).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
      expect(makeBudget().read()?.outstanding).toHaveLength(1);
      expect(await lookup(makeBudget()).search('#3342')).toMatchObject({ knownMatchCount: null, items: [] });
      expect(requestPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'public-pr-header-settle-fixture' });
    }
  });

  it('observes successful exhausted-quota headers and fixes the redirect policy', async () => {
    const reset = Math.floor(Date.now() / 1_000) + 90;
    const fetchImpl = vi.fn(async (_url, _init) => new Response(JSON.stringify({ data: { ok: true } }), {
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    }));
    const observeRateLimit = vi.fn();
    await expect(fetchGitHubGraphql({
      token: 'fixture', query: 'query { viewer { login } }', fetchImpl, rejectRedirects: true, observeRateLimit,
    })).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(observeRateLimit).toHaveBeenCalledTimes(1);
    expect(observeRateLimit.mock.calls[0][0]).toBeGreaterThan(88_000);
  });

  it('finds #3342 after the first 100 open PRs, including a match only in the body', async () => {
    const fetchPage = vi.fn(async (_token, state, cursor) => {
      if (state === 'MERGED') return page([]);
      if (cursor === 'second') return page([row(3342, { body: 'Permanent instar.sh agent addresses' })]);
      const first = cursor === 'first' ? 51 : 1;
      return page(Array.from({ length: 50 }, (_, i) => row(first + i)), cursor === 'first' ? 'second' : 'first');
    });
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => now });
    const result = await lookup.search('INSTAR.SH');
    expect(result).toMatchObject({
      coverage: { open: { status: 'fresh' }, merged: { status: 'fresh', mergedSince: '2026-10-25T03:00:00.000Z' } },
      matchCount: 1,
      items: [{ number: 3342, url: 'https://github.com/JKHeadley/instar/pull/3342' }],
    });
    expect(result.items[0]).not.toHaveProperty('body');
    expect(result.items[0].bodyMatchExcerpt).toBe('Permanent instar.sh agent addresses');
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it('retains validated positives after a repeated cursor and reports an unknown total', async () => {
    const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([row(3342)], 'repeat') : page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => now });
    const result = await lookup.search('#3342');
    expect(result).toMatchObject({ coverage: { open: { status: 'partial' }, merged: { status: 'fresh' } }, matchCount: null, knownMatchCount: 1, items: [{ number: 3342 }] });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('shares one refresh, retains a stale snapshot briefly on failure, and drops it after expiry', async () => {
    let timestamp = now;
    const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([row(3342)]) : page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => timestamp });
    const results = await Promise.all([lookup.search('#3342'), lookup.search('topic/change-3342')]);
    expect(results.map(result => result.matchCount)).toEqual([1, 1]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    fetchPage.mockRejectedValue(new Error('network'));
    timestamp += 120_000;
    expect((await lookup.search('#3342')).coverage.open.status).toBe('stale');
    expect((await lookup.search('missing')).matchCount).toBe(0);
    expect(fetchPage).toHaveBeenCalledTimes(4);
    timestamp = now + 600_000;
    expect((await lookup.search('#3342')).coverage.open.status).toBe('unavailable');
  });

  it('reports a real empty inventory and discards it on credential loss', async () => {
    let token: string | null = 'fixture';
    const fetchPage = vi.fn(async () => page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => token, fetchPage, now: () => now });
    expect(await lookup.search('instar.sh')).toMatchObject({ coverage: { open: { status: 'fresh' } }, matchCount: 0 });
    token = null;
    expect(await lookup.search('instar.sh')).toMatchObject({ coverage: { open: { status: 'unavailable' } }, matchCount: null });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
  it('preserves a complete open inventory if merged history times out on cold start', async () => {
    const fetchPage = vi.fn(async (_token, state) => {
      if (state === 'MERGED') throw new Error('timeout');
      return page([row(3342, { body: 'instar.sh' })]);
    });
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => now });
    expect(await lookup.search('instar.sh')).toMatchObject({
      coverage: { open: { status: 'fresh' }, merged: { status: 'unavailable' } },
      items: [{ number: 3342 }],
    });
    expect((await lookup.search('instar.sh', 'MERGED')).matchCount).toBeNull();
  });

  it('discards both snapshots on an observed authorization denial with a stable token', async () => {
    let timestamp = now;
    const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([row(3342)]) : page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => timestamp });
    expect((await lookup.search('#3342')).matchCount).toBe(1);
    fetchPage.mockRejectedValueOnce(new GitHubGraphqlResponseError('github-graphql-http-401', 'authorization'));
    timestamp += 120_000;
    expect(await lookup.search('#3342')).toMatchObject({
      coverage: { open: { status: 'unavailable' }, merged: { status: 'unavailable' } },
      matchCount: null,
      items: [],
    });
  });

  it('ranks a relevant title over overflow of noisy body matches and supports exact narrowing', async () => {
    const noisy = Array.from({ length: 22 }, (_, i) => row(i + 1, { body: 'instar.sh' }));
    const matching = row(3342, { title: 'instar.sh' });
    const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([...noisy, matching]) : page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => now });
    const result = await lookup.search('instar.sh');
    expect(result).toMatchObject({ matchKind: 'literal', nextOffset: 20, matchCount: 23 });
    expect(result.items).toHaveLength(20);
    expect(result.items[0].number).toBe(3342);
    const next = await lookup.search('instar.sh', undefined, 20);
    expect(next.revision).toBe(result.revision);
    expect(next.items).toHaveLength(3);
    expect(next.nextOffset).toBeNull();
    expect((await lookup.search('#1')).items.map(item => item.number)).toEqual([1]);
  });

  it.each(['denial first', 'success first'])('invalidates parallel rows when authorization denial completes %s', async (order) => {
    let timestamp = now;
    const fetchPage = vi.fn(async (_token, state) => state === 'OPEN' ? page([row(3342)]) : page([]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => timestamp });
    expect((await lookup.search('#3342')).matchCount).toBe(1);
    timestamp += 120_000;

    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    };
    const open = deferred<ReturnType<typeof page>>();
    const merged = deferred<ReturnType<typeof page>>();
    fetchPage.mockImplementationOnce(() => open.promise).mockImplementationOnce(() => merged.promise);
    const searching = lookup.search('#3342');
    if (order === 'denial first') {
      merged.reject(new GitHubGraphqlResponseError('github-graphql-errors-1', 'authorization'));
      await new Promise<void>(resolve => queueMicrotask(resolve));
      open.resolve(page([row(3342)]));
    } else {
      open.resolve(page([row(3342)]));
      await new Promise<void>(resolve => queueMicrotask(resolve));
      merged.reject(new GitHubGraphqlResponseError('github-graphql-errors-1', 'authorization'));
    }
    expect(await searching).toMatchObject({ knownMatchCount: null, items: [] });
    timestamp += 15_000;
    expect((await lookup.search('#3342')).matchCount).toBe(1);
  });

  it('publishes partial positive results before the open traversal reaches its page bound', async () => {
    const fetchPage = vi.fn(async (_token, state, cursor) => {
      if (state === 'MERGED') return page([]);
      const step = Number(cursor ?? 0);
      return page([row(step === 0 ? 3342 : step)], String(step + 1));
    });
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => now });
    expect(await lookup.search('#3342')).toMatchObject({
      coverage: { open: { status: 'partial' } }, matchCount: null, knownMatchCount: 1,
      items: [{ number: 3342 }],
    });
    expect(fetchPage).toHaveBeenCalledTimes(101);
  });

  it('uses prior positives only where the partial scan did not observe the number', async () => {
    let timestamp = now;
    let partial = false;
    const oldRows = [row(3342, { body: 'instar.sh' }), row(125, { body: 'instar.sh' })];
    const fetchPage = vi.fn(async (_token, state, cursor) => {
      if (state === 'MERGED') return page([]);
      if (cursor) throw new Error('late page unavailable');
      if (partial) return page([row(3342, { body: 'Now a different design' })], 'page-2');
      return page(oldRows);
    });
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => timestamp });
    expect((await lookup.search('instar.sh')).matchCount).toBe(2);
    timestamp += 120_000;
    partial = true;
    const result = await lookup.search('instar.sh');
    expect(result).toMatchObject({ matchCount: null, knownMatchCount: 1, coverage: { open: { status: 'partial' } } });
    expect(result.items).toMatchObject([{ number: 125, priorComplete: true, observedAt: new Date(now).toISOString() }]);
  });

  it('prefers the terminal merged row at equal time before testing the query', async () => {
    const open = row(3342, { body: 'instar.sh' });
    const merged = row(3342, { state: 'MERGED', mergedAt: open.updatedAt, body: 'A changed design' });
    const fetchPage = vi.fn(async (_token, state) => page([state === 'OPEN' ? open : merged]));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => now });
    expect((await lookup.search('instar.sh')).matchCount).toBe(0);
    expect((await lookup.search('#3342')).items).toMatchObject([{ number: 3342, state: 'MERGED' }]);
  });

  it('does not replace retained terminal merged evidence with a contradictory open observation', async () => {
    let timestamp = now;
    let changed = false;
    const merged = (number: number) => row(number, { state: 'MERGED', mergedAt: new Date(now).toISOString() });
    const fetchPage = vi.fn(async (_token, state, cursor) => {
      if (state === 'OPEN') return page(changed ? [row(3342)] : []);
      if (cursor) throw new Error('merged traversal interrupted');
      return changed ? page([merged(117)], 'next') : page([merged(3342)]);
    });
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => timestamp });
    expect((await lookup.search('#3342')).items).toMatchObject([{ number: 3342, state: 'MERGED', priorComplete: false }]);
    changed = true;
    timestamp += 120_000;
    const result = await lookup.search('#3342');
    expect(result).toMatchObject({
      coverage: { open: { status: 'fresh' }, merged: { status: 'partial' } },
      matchCount: null,
      items: [{ number: 3342, state: 'MERGED', priorComplete: true }],
    });
  });

  it('keeps the anchored merged cutoff stable across two result pages as the clock crosses it', async () => {
    let timestamp = now;
    const edge = new Date(now - 30 * 24 * 60 * 60_000 + 500).toISOString();
    const rows = Array.from({ length: 21 }, (_, i) =>
      row(i + 1, { state: 'MERGED', title: 'instar.sh', mergedAt: i === 20 ? edge : new Date(now).toISOString() }));
    const fetchPage = vi.fn(async (_token, state) => page(state === 'MERGED' ? rows : []));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => timestamp });
    const first = await lookup.search('instar.sh', 'MERGED');
    expect(first.items[0].number).toBe(21);
    expect(first.matchCount).toBe(21);
    expect(first.nextOffset).toBe(20);
    timestamp += 1000;
    const second = await lookup.search('instar.sh', 'MERGED', 20);
    expect(second.revision).toBe(first.revision);
    expect(second.coverage.merged.mergedSince).toBe(first.coverage.merged.mergedSince);
    expect(second.items.map(item => item.number)).toEqual([1]);
  });

  it('does not supplement a partial merged snapshot with positives outside its anchored window', async () => {
    let timestamp = now;
    let partial = false;
    const edge = new Date(now - 30 * 24 * 60 * 60_000 + 500).toISOString();
    const earlier = row(3342, { state: 'MERGED', title: 'instar.sh', mergedAt: edge });
    const fetchPage = vi.fn(async (_token, state, cursor) => {
      if (state === 'OPEN') return page([]);
      if (cursor) throw new Error('network');
      if (!partial) return page([earlier]);
      return page([row(321, { state: 'MERGED', mergedAt: new Date(now).toISOString() })], 'next');
    });
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => timestamp });
    expect((await lookup.search('instar.sh')).items).toMatchObject([{ number: 3342 }]);
    partial = true;
    timestamp += 120_000;
    const result = await lookup.search('instar.sh');
    expect(result).toMatchObject({ coverage: { merged: { status: 'partial' } }, matchCount: null, knownMatchCount: 0, items: [] });
  });

  it('returns a flagged excerpt overlapping a body-only literal longer than the excerpt', async () => {
    const literal = 'a'.repeat(256);
    const body = `prefix ${literal} suffix`;
    const fetchPage = vi.fn(async (_token, state) => page(state === 'OPEN' ? [row(3342, { body })] : []));
    const lookup = new ChiefOfStaffPrSearch({ readToken: () => 'fixture', fetchPage, now: () => now });
    const { items } = await lookup.search(literal);
    expect(items[0]).toMatchObject({ number: 3342, bodyMatchExcerpt: body.slice(0, 240), excerptTruncated: true });
  });

});

import { describe, expect, it, vi } from 'vitest';
import { GitHubGraphqlResponseError } from '../../src/core/githubRuntime.js';
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

/**
 * PrLinkReviewerCheck — the send-time "every PR link arrives with its reviewer
 * requested" check, against a fake GitHub. Spec: docs/specs/pr-link-requests-reviewer.md.
 */
import { describe, it, expect, vi } from 'vitest';
import { PrLinkReviewerCheck, prLinkHoldMessage, clampTimeoutMs, isPermanentPrLinkFailure } from '../../src/core/PrLinkReviewerCheck.js';

const PR_URL = 'https://api.github.com/repos/JKHeadley/instar/pulls/3050';
const HEAD = 'a'.repeat(40);

type Route = { status: number; body?: unknown } | ((init: RequestInit) => { status: number; body?: unknown } | Promise<never>);

function fakeGitHub(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url}`];
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const r = typeof route === 'function' ? await route(init) : route;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function openPr(over: Record<string, unknown> = {}) {
  return {
    state: 'open',
    merged: false,
    user: { login: 'EchoOfDawn' },
    head: { sha: HEAD },
    requested_reviewers: [],
    base: { repo: { owner: { login: 'JKHeadley', type: 'User' }, permissions: { push: true } } },
    ...over,
  };
}

const TEXT = 'Ready for you: https://github.com/JKHeadley/instar/pull/3050';

function make(routes: Record<string, Route>, token: string | null = 'tok') {
  const gh = fakeGitHub(routes);
  return { check: new PrLinkReviewerCheck({ resolveToken: () => token, fetchImpl: gh.fetchImpl }), calls: gh.calls };
}

describe('PrLinkReviewerCheck', () => {
  it('passes a message with no PR link without calling GitHub', async () => {
    const { check, calls } = make({});
    expect(await check.check('no links here https://github.com/a/b/issues/1')).toEqual({ ok: true, outcomes: [] });
    expect(calls).toHaveLength(0);
  });

  it('requests the repo owner when not yet requested, and confirms it', async () => {
    const { check, calls } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [] },
      [`POST ${PR_URL}/requested_reviewers`]: { status: 201, body: { requested_reviewers: [{ login: 'JKHeadley' }] } },
    });
    const r = await check.check(TEXT);
    expect(r.ok).toBe(true);
    expect(r.outcomes).toEqual([{ pr: 'JKHeadley/instar#3050', status: 'requested', reviewer: 'JKHeadley' }]);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { reviewers: ['JKHeadley'] } });
  });

  it('does nothing more when the reviewer is already requested', async () => {
    const { check, calls } = make({ [`GET ${PR_URL}`]: { status: 200, body: openPr({ requested_reviewers: [{ login: 'jkheadley' }] }) } });
    const r = await check.check(TEXT);
    expect(r.outcomes[0]).toMatchObject({ status: 'already-requested' });
    expect(calls).toHaveLength(1);
  });

  it('does not re-request a reviewer who approved the current head', async () => {
    const { check, calls } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [{ user: { login: 'JKHeadley' }, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-11-10T01:00:00Z' }] },
    });
    const r = await check.check(TEXT);
    expect(r.outcomes[0]).toMatchObject({ status: 'approved-at-head' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('re-requests when the approval is on an older head (a dismissed or stale review)', async () => {
    const { check } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [{ user: { login: 'JKHeadley' }, state: 'APPROVED', commit_id: 'b'.repeat(40), submitted_at: '2026-11-10T01:00:00Z' }] },
      [`POST ${PR_URL}/requested_reviewers`]: { status: 201, body: { requested_reviewers: [{ login: 'JKHeadley' }] } },
    });
    expect((await check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'requested' });
  });

  it.each([
    ['merged', { state: 'closed', merged: true }],
    ['closed', { state: 'closed', merged: false }],
  ])('passes a %s PR untouched', async (_label, over) => {
    const { check, calls } = make({ [`GET ${PR_URL}`]: { status: 200, body: openPr(over) } });
    const r = await check.check(TEXT);
    expect(r).toMatchObject({ ok: true, outcomes: [{ status: 'skipped', reason: 'not-open' }] });
    expect(calls).toHaveLength(1);
  });

  it('passes a PR it cannot see (404) and a repo it cannot write to', async () => {
    expect((await make({}).check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'skipped', reason: 'not-visible' });
    const ro = make({ [`GET ${PR_URL}`]: { status: 200, body: openPr({ base: { repo: { owner: { login: 'JKHeadley', type: 'User' }, permissions: { push: false, triage: false, pull: true } } } }) } });
    expect((await ro.check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'skipped', reason: 'no-write-access' });
  });

  it('passes when nobody can be asked: the owner is the author, or an organisation with no configured login', async () => {
    const own = make({ [`GET ${PR_URL}`]: { status: 200, body: openPr({ user: { login: 'JKHeadley' } }) } });
    expect((await own.check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'skipped', reason: 'no-reviewer' });
    const org = make({ [`GET ${PR_URL}`]: { status: 200, body: openPr({ base: { repo: { owner: { login: 'SomeOrg', type: 'Organization' } } } }) } });
    expect((await org.check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'skipped', reason: 'no-reviewer' });
  });

  it('uses the configured reviewer for the repo instead of the owner', async () => {
    const { check, calls } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [] },
      [`POST ${PR_URL}/requested_reviewers`]: { status: 201, body: { requested_reviewers: [{ login: 'alice' }] } },
    });
    const r = await check.check(TEXT, { reviewerFor: (n) => (n === 'JKHeadley/instar' ? ['alice'] : []) });
    expect(r.outcomes[0]).toMatchObject({ status: 'requested', reviewer: 'alice' });
    expect(calls.at(-1)?.body).toEqual({ reviewers: ['alice'] });
  });

  it('a candidate who is the PR author falls through to the next candidate', async () => {
    const { check, calls } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr({ user: { login: 'alice' } }) },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [] },
      [`POST ${PR_URL}/requested_reviewers`]: { status: 201, body: { requested_reviewers: [{ login: 'bob' }] } },
    });
    const r = await check.check(TEXT, { reviewerFor: () => ['alice', 'bob'] });
    expect(r.outcomes[0]).toMatchObject({ status: 'requested', reviewer: 'bob' });
    expect(calls.at(-1)?.body).toEqual({ reviewers: ['bob'] });
  });

  it('a 2xx PR view with no readable body fails, never reads as not-open', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const r = await new PrLinkReviewerCheck({ resolveToken: () => 'tok', fetchImpl }).check(TEXT);
    expect(r.failure).toMatchObject({ reason: 'github-unreachable' });
  });

  it('a deadline that fires while the body is read is a timeout, not a pass', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => ({
      status: 200,
      json: () => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    })) as unknown as typeof fetch;
    const r = await new PrLinkReviewerCheck({ resolveToken: () => 'tok', fetchImpl }).check(TEXT, { timeoutMs: 1000 });
    expect(r.failure?.reason).toBe('github-timeout');
  });

  it('a 404 on the request (token cannot write here) passes like a read-only repo', async () => {
    const { check } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [] },
    });
    expect((await check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'skipped', reason: 'no-write-access' });
  });

  it('skips repos outside the configured allowlist', async () => {
    const { check, calls } = make({});
    const r = await check.check(TEXT, { repos: ['other/repo'] });
    expect(r.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'not-in-repos' });
    expect(calls).toHaveLength(0);
  });

  it('fails when GitHub rejects the request (422)', async () => {
    const { check } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [] },
      [`POST ${PR_URL}/requested_reviewers`]: { status: 422, body: { message: 'Reviews may only be requested from collaborators.' } },
    });
    const r = await check.check(TEXT);
    expect(r.ok).toBe(false);
    expect(r.failure).toMatchObject({ reason: 'request-rejected', reviewer: 'JKHeadley' });
    expect(r.failure?.detail).toContain('collaborators');
  });

  it('fails when the request is accepted but the reviewer is not listed', async () => {
    const { check } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [] },
      [`POST ${PR_URL}/requested_reviewers`]: { status: 201, body: { requested_reviewers: [] } },
    });
    expect((await check.check(TEXT)).failure?.reason).toBe('request-not-confirmed');
  });

  it('fails on missing token, auth refusal and server errors', async () => {
    expect((await make({}, null).check.check(TEXT)).failure?.reason).toBe('no-github-token');
    expect((await make({ [`GET ${PR_URL}`]: { status: 401 } }).check.check(TEXT)).failure?.reason).toBe('github-auth');
    expect((await make({ [`GET ${PR_URL}`]: { status: 502 } }).check.check(TEXT)).failure?.reason).toBe('github-unreachable');
  });

  it('fails on a network error without leaking its message', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('connect ECONNREFUSED token=secret'); }) as unknown as typeof fetch;
    const r = await new PrLinkReviewerCheck({ resolveToken: () => 'tok', fetchImpl }).check(TEXT);
    expect(r.failure).toMatchObject({ reason: 'github-unreachable', detail: 'TypeError' });
  });

  it('is bounded: a GitHub that never answers fails with github-timeout within the budget', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    const r = await new PrLinkReviewerCheck({ resolveToken: () => 'tok', fetchImpl }).check(TEXT, { timeoutMs: 1000 });
    expect(r.failure?.reason).toBe('github-timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('remembers a satisfied PR briefly so a re-send does not call GitHub again', async () => {
    // GitHub's PR view lags (still shows nobody requested) — the cache must stop a second POST.
    const gh = fakeGitHub({
      [`GET ${PR_URL}`]: { status: 200, body: openPr() },
      [`GET ${PR_URL}/reviews?per_page=100`]: { status: 200, body: [] },
      [`POST ${PR_URL}/requested_reviewers`]: { status: 201, body: { requested_reviewers: [{ login: 'JKHeadley' }] } },
    });
    const check = new PrLinkReviewerCheck({ resolveToken: () => 'tok', fetchImpl: gh.fetchImpl });
    expect((await check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'requested' });
    expect((await check.check(TEXT)).outcomes[0]).toMatchObject({ status: 'already-requested' });
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('stops at the first failing PR and reports earlier outcomes', async () => {
    const second = 'https://api.github.com/repos/JKHeadley/instar/pulls/3051';
    const { check } = make({
      [`GET ${PR_URL}`]: { status: 200, body: openPr({ state: 'closed' }) },
      [`GET ${second}`]: { status: 500 },
    });
    const r = await check.check(`${TEXT} and https://github.com/JKHeadley/instar/pull/3051`);
    expect(r.ok).toBe(false);
    expect(r.outcomes.map((o) => o.status)).toEqual(['skipped', 'failed']);
    expect(r.failure?.pr).toBe('JKHeadley/instar#3051');
  });
});

describe('prLinkHoldMessage / clampTimeoutMs', () => {
  it('names the PR, the reviewer and a plain reason', () => {
    const msg = prLinkHoldMessage({ pr: 'JKHeadley/instar#3050', status: 'failed', reason: 'github-timeout', reviewer: 'JKHeadley' });
    expect(msg).toContain('Not sent yet');
    expect(msg).toContain('JKHeadley/instar#3050');
    expect(msg).toContain('JKHeadley a requested reviewer');
    expect(msg).toContain('did not answer in time');
    expect(msg).toContain('Retry in a minute');
  });
  it('does not tell the sender to retry a failure that recurs', () => {
    const msg = prLinkHoldMessage({ pr: 'a/b#1', status: 'failed', reason: 'request-rejected', reviewer: 'x', detail: 'HTTP 422: Reviews may only be requested from collaborators.' });
    expect(msg).not.toContain('Retry in a minute');
    expect(msg).toContain('collaborators');
    expect(isPermanentPrLinkFailure('request-rejected')).toBe(true);
    expect(isPermanentPrLinkFailure('github-timeout')).toBe(false);
  });
  it('clamps the budget', () => {
    expect(clampTimeoutMs(undefined)).toBe(5000);
    expect(clampTimeoutMs(10)).toBe(1000);
    expect(clampTimeoutMs(99_999)).toBe(8_000);
  });
});

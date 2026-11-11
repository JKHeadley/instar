import { describe, expect, it, vi } from 'vitest';
import {
  applyPrLinkReviewRequests, createSelfLoginReader, ensureReviewerOnPr, extractPrLinks, MAX_PR_LINKS,
} from '../../src/messaging/prLinkReviewRequest.js';
import type { AuthenticatedGhExec } from '../../src/core/githubRuntime.js';

/** A fake GitHub: one PR, a requested-reviewer list POST really mutates, reviews list. */
function fakeGitHub(opts: {
  state?: string; author?: string; ownerType?: string; requested?: string[]; reviews?: unknown[];
  postFails?: boolean; postIsNoop?: boolean; viewFails?: boolean; headSha?: string;
} = {}) {
  const requested = [...(opts.requested ?? [])];
  const calls: string[][] = [];
  const gh: AuthenticatedGhExec = vi.fn(async (args: string[]) => {
    calls.push(args);
    const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
    const path = args[1] === '-X' ? args[3] : args[1];
    if (path === 'user') return { code: 0, stdout: 'EchoOfDawn\n', stderr: '' };
    if (path === 'repos/JKHeadley/instar/pulls/3046') {
      if (opts.viewFails) return { code: 1, stdout: '', stderr: 'gh: HTTP 502' };
      return ok({ state: opts.state ?? 'open', user: { login: opts.author ?? 'EchoOfDawn' }, head: { sha: opts.headSha ?? 'abc' },
        requested_reviewers: requested.map(login => ({ login })),
        base: { repo: { owner: { login: 'JKHeadley', type: opts.ownerType ?? 'User' } } } });
    }
    if (path === 'repos/JKHeadley/instar/pulls/3046/reviews?per_page=100') return ok(opts.reviews ?? []);
    if (path === 'repos/JKHeadley/instar/pulls/3046/requested_reviewers') {
      if (args[1] === '-X') {
        if (opts.postFails) return { code: 1, stdout: '', stderr: 'gh: Reviews may only be requested from collaborators. (HTTP 422)' };
        if (!opts.postIsNoop) requested.push(args[5].replace('reviewers[]=', ''));
        return ok({});
      }
      return ok({ users: requested.map(login => ({ login })), teams: [] });
    }
    return { code: 1, stdout: '', stderr: `unexpected ${path}` };
  });
  return { gh, calls, requested };
}

const ref = { owner: 'JKHeadley', repo: 'instar', number: 3046 };
const self = async () => 'EchoOfDawn';
const LINK = 'Please approve: https://github.com/JKHeadley/instar/pull/3046';

describe('extractPrLinks', () => {
  it('finds distinct PR links, ignores issues and other hosts, caps the count', () => {
    const text = 'a https://github.com/JKHeadley/instar/pull/3046/files b https://github.com/JKHeadley/instar/pull/3046 '
      + 'c https://github.com/JKHeadley/instar/issues/9 d https://example.com/x/y/pull/1 e https://github.com/a/b/pull/12';
    expect(extractPrLinks(text)).toEqual([ref, { owner: 'a', repo: 'b', number: 12 }]);
    const many = Array.from({ length: 9 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`).join(' ');
    expect(extractPrLinks(many)).toHaveLength(MAX_PR_LINKS);
  });
});

describe('ensureReviewerOnPr', () => {
  it('requests the repo owner when missing (the #3046 case: review dismissed, no request left) and reads it back', async () => {
    const g = fakeGitHub({ reviews: [{ user: { login: 'JKHeadley' }, state: 'DISMISSED', commit_id: 'old' }] });
    const r = await ensureReviewerOnPr(ref, { gh: g.gh, selfLogin: self });
    expect(r).toMatchObject({ outcome: 'requested', reviewer: 'JKHeadley' });
    expect(g.calls.some(c => c[1] === '-X' && c[2] === 'POST')).toBe(true);
    expect(g.requested).toEqual(['JKHeadley']);
  });

  it('does nothing when already requested', async () => {
    const g = fakeGitHub({ requested: ['JKHeadley'] });
    expect((await ensureReviewerOnPr(ref, { gh: g.gh, selfLogin: self })).outcome).toBe('already-requested');
    expect(g.calls.some(c => c[1] === '-X')).toBe(false);
  });

  it('reports failed when GitHub refuses, and when the POST succeeds but the request is not there', async () => {
    const refused = await ensureReviewerOnPr(ref, { gh: fakeGitHub({ postFails: true }).gh, selfLogin: self });
    expect(refused).toMatchObject({ outcome: 'failed', reviewer: 'JKHeadley' });
    expect(refused.reason).toMatch(/collaborators/);
    const ghost = await ensureReviewerOnPr(ref, { gh: fakeGitHub({ postIsNoop: true }).gh, selfLogin: self });
    expect(ghost).toMatchObject({ outcome: 'failed', reason: 'the request did not show up on the PR' });
  });

  it('skips closed PRs, PRs the agent did not author, org owners without a configured reviewer, and author == reviewer', async () => {
    expect((await ensureReviewerOnPr(ref, { gh: fakeGitHub({ state: 'closed' }).gh, selfLogin: self })).outcome).toBe('skipped-not-open');
    expect((await ensureReviewerOnPr(ref, { gh: fakeGitHub({ author: 'someone' }).gh, selfLogin: self })).outcome).toBe('skipped-not-agent-pr');
    expect((await ensureReviewerOnPr(ref, { gh: fakeGitHub({ ownerType: 'Organization' }).gh, selfLogin: self })).outcome).toBe('skipped-no-reviewer');
    expect((await ensureReviewerOnPr(ref, { gh: fakeGitHub().gh, selfLogin: self, reviewer: 'EchoOfDawn' })).outcome).toBe('skipped-reviewer-is-author');
  });

  it('uses the configured reviewer over the owner', async () => {
    const g = fakeGitHub({ ownerType: 'Organization' });
    expect(await ensureReviewerOnPr(ref, { gh: g.gh, selfLogin: self, reviewer: 'alice' })).toMatchObject({ outcome: 'requested', reviewer: 'alice' });
  });

  it('does not re-ping a reviewer who approved the current head, but does after a new push', async () => {
    const approved = [{ user: { login: 'JKHeadley' }, state: 'APPROVED', commit_id: 'abc' }];
    expect((await ensureReviewerOnPr(ref, { gh: fakeGitHub({ reviews: approved }).gh, selfLogin: self })).outcome).toBe('skipped-approved-at-head');
    expect((await ensureReviewerOnPr(ref, { gh: fakeGitHub({ reviews: approved, headSha: 'newer' }).gh, selfLogin: self })).outcome).toBe('requested');
  });
});

describe('applyPrLinkReviewRequests', () => {
  it('leaves text without PR links untouched and calls nothing', async () => {
    const g = fakeGitHub();
    expect((await applyPrLinkReviewRequests('no links here', { gh: g.gh, selfLogin: self, maxLength: 4096 })).text).toBe('no links here');
    expect(g.calls).toHaveLength(0);
  });

  it('sends the text unchanged when the request is confirmed', async () => {
    const out = await applyPrLinkReviewRequests(LINK, { gh: fakeGitHub().gh, selfLogin: self, maxLength: 4096 });
    expect(out.text).toBe(LINK);
    expect(out.results[0].outcome).toBe('requested');
  });

  it('appends a plain note when the request on the agent PR cannot be confirmed, within the length limit only', async () => {
    const out = await applyPrLinkReviewRequests(LINK, { gh: fakeGitHub({ postFails: true }).gh, selfLogin: self, maxLength: 4096 });
    expect(out.text.startsWith(LINK)).toBe(true);
    expect(out.text).toMatch(/Note: I could not confirm JKHeadley as a reviewer on PR #3046/);
    const tight = await applyPrLinkReviewRequests(LINK, { gh: fakeGitHub({ postFails: true }).gh, selfLogin: self, maxLength: LINK.length + 10 });
    expect(tight.text).toBe(LINK);
  });

  it('a PR that cannot be read is unreadable (maybe not ours): logged, text unchanged', async () => {
    const out = await applyPrLinkReviewRequests(LINK, { gh: fakeGitHub({ viewFails: true }).gh, selfLogin: self, maxLength: 4096 });
    expect(out.results[0].outcome).toBe('unreadable');
    expect(out.text).toBe(LINK);
  });

  it('a slow GitHub never holds the reply; a note only once the PR is known to be ours', async () => {
    const hang: AuthenticatedGhExec = () => new Promise(() => undefined);
    const unknown = await applyPrLinkReviewRequests(LINK, { gh: hang, selfLogin: self, maxLength: 4096, budgetMs: 20, reviewer: 'JKHeadley' });
    expect(unknown.timedOut).toBe(true);
    expect(unknown.text).toBe(LINK);
    const g = fakeGitHub();
    const hangOnPost: AuthenticatedGhExec = (args) => (args[1] === '-X' ? new Promise(() => undefined) : g.gh(args));
    const known = await applyPrLinkReviewRequests(LINK, { gh: hangOnPost, selfLogin: self, maxLength: 4096, budgetMs: 50, reviewer: 'JKHeadley' });
    expect(known.text).toMatch(/could not confirm JKHeadley as a reviewer on PR #3046 \(GitHub did not answer in time\)/);
  });
});

describe('createSelfLoginReader', () => {
  it('caches a successful read only', async () => {
    let n = 0;
    const gh: AuthenticatedGhExec = async () => (++n === 1 ? { code: 1, stdout: '', stderr: 'x' } : { code: 0, stdout: 'EchoOfDawn\n', stderr: '' });
    const read = createSelfLoginReader(gh);
    expect(await read()).toBeNull();
    expect(await read()).toBe('EchoOfDawn');
    expect(await read()).toBe('EchoOfDawn');
    expect(n).toBe(2);
  });
});

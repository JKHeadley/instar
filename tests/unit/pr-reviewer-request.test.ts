/**
 * The shared reviewer logic used by safe-merge (merge-refusal time) and the
 * send-time PR-link check. Spec: docs/specs/pr-link-requests-reviewer.md.
 */
import { describe, it, expect } from 'vitest';
import {
  extractPullRequestLinks,
  resolveReviewerLogins,
  requestedReviewerLogins,
  confirmedRequested,
  toReviewLike,
  MAX_PR_LINKS_PER_MESSAGE,
} from '../../scripts/pr-reviewer-request.mjs';

describe('extractPullRequestLinks', () => {
  it('finds a pull-request link with or without scheme', () => {
    expect(extractPullRequestLinks('see https://github.com/JKHeadley/instar/pull/3050 please')).toEqual([
      { owner: 'JKHeadley', repo: 'instar', number: 3050, fullName: 'JKHeadley/instar' },
    ]);
    expect(extractPullRequestLinks('github.com/a/b/pull/7')[0]).toMatchObject({ owner: 'a', repo: 'b', number: 7 });
  });

  it('treats sub-pages and anchors as the same PR, and de-duplicates case-insensitively', () => {
    const links = extractPullRequestLinks(
      'https://github.com/JKHeadley/instar/pull/12/files and https://github.com/jkheadley/INSTAR/pull/12#discussion_r1 and https://github.com/JKHeadley/instar/pull/13',
    );
    expect(links.map((l) => l.number)).toEqual([12, 13]);
  });

  it('ignores issues, bare #refs, other hosts and non-numeric pulls', () => {
    expect(extractPullRequestLinks('https://github.com/a/b/issues/5 #12 https://gitlab.com/a/b/pull/3 https://github.com/a/b/pulls')).toEqual([]);
  });

  it('does not truncate a longer number into a shorter PR', () => {
    expect(extractPullRequestLinks('https://github.com/a/b/pull/1234')[0].number).toBe(1234);
  });

  it('caps the number of PRs checked per message', () => {
    const text = Array.from({ length: 9 }, (_, i) => `https://github.com/a/b/pull/${i + 1}`).join(' ');
    expect(extractPullRequestLinks(text)).toHaveLength(MAX_PR_LINKS_PER_MESSAGE);
  });

  it('returns nothing for non-strings', () => {
    expect(extractPullRequestLinks(undefined)).toEqual([]);
    expect(extractPullRequestLinks(42)).toEqual([]);
  });
});

describe('resolveReviewerLogins', () => {
  it('defaults to the repo owner', () => {
    expect(resolveReviewerLogins({ repoOwner: 'JKHeadley', author: 'EchoOfDawn' })).toEqual(['JKHeadley']);
  });
  it('explicit logins beat the owner', () => {
    expect(resolveReviewerLogins({ explicit: ['alice'], repoOwner: 'JKHeadley' })).toEqual(['alice']);
  });
  it('never returns the PR author (case-insensitive)', () => {
    expect(resolveReviewerLogins({ repoOwner: 'JKHeadley', author: 'jkheadley' })).toEqual([]);
    expect(resolveReviewerLogins({ explicit: ['bob', 'Carol'], author: 'carol' })).toEqual(['bob']);
  });
  it('drops invalid logins and duplicates', () => {
    expect(resolveReviewerLogins({ explicit: ['-bad', 'ok', 'OK', '', 'has space'] })).toEqual(['ok']);
  });
  it('returns nothing with no owner and no explicit login', () => {
    expect(resolveReviewerLogins({})).toEqual([]);
  });
});

describe('requested reviewer parsing', () => {
  it('reads logins from a requested_reviewers array', () => {
    expect(requestedReviewerLogins([{ login: 'a' }, null, { id: 1 }, { login: 'b' }])).toEqual(['a', 'b']);
    expect(requestedReviewerLogins(undefined)).toEqual([]);
  });
  it('confirms only the logins the POST response lists', () => {
    expect(confirmedRequested({ requested_reviewers: [{ login: 'JKHeadley' }] }, ['jkheadley', 'x'])).toEqual(['jkheadley']);
    expect(confirmedRequested(JSON.stringify({ requested_reviewers: [] }), ['a'])).toEqual([]);
  });
  it('treats an unparseable 2xx body as success (the request is idempotent)', () => {
    expect(confirmedRequested('not json', ['a'])).toEqual(['a']);
  });
});

describe('toReviewLike', () => {
  it('maps REST reviews to the approvedAtHead shape', () => {
    expect(toReviewLike([{ user: { login: 'a' }, state: 'APPROVED', commit_id: 'abc', submitted_at: '2026-11-10T00:00:00Z' }])).toEqual([
      { login: 'a', state: 'APPROVED', commitId: 'abc', submittedAt: '2026-11-10T00:00:00Z' },
    ]);
    expect(toReviewLike(null)).toEqual([]);
  });
});

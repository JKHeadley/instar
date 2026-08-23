/**
 * Path B of the standards direction guard: operator ratification via a GitHub
 * code-owner review (spec: docs/specs/standards-approval-via-github-review.md,
 * "The check, precisely").
 *
 * The fixture at tests/fixtures/github-pr-1966-reviews.json is the REAL
 * captured /pulls/1966/reviews response — the first ratification this path
 * ever verified. Synthetic variants are derived from it, never invented
 * wholesale, so the shape the code parses is the shape GitHub actually sends.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateStandardsDirection,
  verifyGithubReviewApproval,
  applyGithubReviewRatification,
} from '../../scripts/standards-direction-guard.mjs';

const REAL_REVIEWS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/github-pr-1966-reviews.json'), 'utf8'),
);
const HEAD_SHA = REAL_REVIEWS[0].commit_id;
const OWNER_LOGIN = REAL_REVIEWS[0].user.login;

function eventFile(overrides: Record<string, unknown> = {}): string {
  const payload = {
    pull_request: {
      number: 1966,
      head: { sha: HEAD_SHA },
      user: { login: 'echo-agent' },
      ...(overrides.pull_request as object ?? {}),
    },
    repository: {
      full_name: 'JKHeadley/instar',
      owner: { login: OWNER_LOGIN, type: 'User' },
      ...(overrides.repository as object ?? {}),
    },
  };
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghrev-')), 'event.json');
  fs.writeFileSync(p, JSON.stringify(payload));
  return p;
}

function fetchReturning(body: unknown, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

const BASE_ARGS = { eventName: 'pull_request', token: 't', apiBase: 'https://api.example' };

describe('verifyGithubReviewApproval', () => {
  it('accepts the REAL captured approval bound to the head commit', async () => {
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning(REAL_REVIEWS),
    });
    expect(r).toMatchObject({ available: true, accepted: true });
    expect(r.approval).toMatchObject({ login: OWNER_LOGIN, commitId: HEAD_SHA });
  });

  it('rejects an approval bound to a DIFFERENT commit — approve-then-push is not covered', async () => {
    const stale = [{ ...REAL_REVIEWS[0], commit_id: 'f'.repeat(40) }];
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning(stale),
    });
    expect(r).toMatchObject({ available: true, accepted: false, reason: 'no-review-on-head-commit' });
  });

  it('a LATER CHANGES_REQUESTED from the owner withdraws the approval', async () => {
    const later = {
      ...REAL_REVIEWS[0], id: 99, state: 'CHANGES_REQUESTED',
      submitted_at: '2026-08-23T06:00:00Z',
    };
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning([REAL_REVIEWS[0], later]),
    });
    expect(r).toMatchObject({ available: true, accepted: false, reason: 'latest-review-changes_requested' });
  });

  it('a DISMISSED approval does not count', async () => {
    const dismissed = [{ ...REAL_REVIEWS[0], state: 'DISMISSED' }];
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning(dismissed),
    });
    expect(r).toMatchObject({ available: true, accepted: false, reason: 'latest-review-dismissed' });
  });

  it('a COMMENTED review neither approves nor withdraws', async () => {
    const comment = {
      ...REAL_REVIEWS[0], id: 98, state: 'COMMENTED', submitted_at: '2026-08-23T06:00:00Z',
    };
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning([REAL_REVIEWS[0], comment]),
    });
    expect(r).toMatchObject({ available: true, accepted: true });
  });

  it('an unrecognized review state withdraws — vocabulary drift fails closed', async () => {
    const weird = [{ ...REAL_REVIEWS[0], state: 'PENDING_SOMETHING_NEW' }];
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning(weird),
    });
    expect(r).toMatchObject({ available: true, accepted: false });
  });

  it('an organization owner is UNAVAILABLE — no individual to bind the approval to', async () => {
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS,
      eventPath: eventFile({ repository: { full_name: 'JKHeadley/instar', owner: { login: 'some-org', type: 'Organization' } } }),
      fetchImpl: fetchReturning(REAL_REVIEWS),
    });
    expect(r).toMatchObject({ available: false, reason: 'owner-not-a-user' });
  });

  it('an owner-authored PR is UNAVAILABLE — approver must not be the author', async () => {
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS,
      eventPath: eventFile({ pull_request: { number: 1, head: { sha: HEAD_SHA }, user: { login: OWNER_LOGIN } } }),
      fetchImpl: fetchReturning(REAL_REVIEWS),
    });
    expect(r).toMatchObject({ available: false, reason: 'owner-authored-pr' });
  });

  it('API failure is UNAVAILABLE with a named reason — never a silent pass', async () => {
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning({}, 403),
    });
    expect(r).toMatchObject({ available: false, reason: 'api-status-403' });
  });

  it('a non-PR event is UNAVAILABLE', async () => {
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventName: 'push', eventPath: eventFile(), fetchImpl: fetchReturning(REAL_REVIEWS),
    });
    expect(r).toMatchObject({ available: false, reason: 'non-pr-event:push' });
  });

  it('an owner WITHOUT a login plus a userless review is payload-shape UNAVAILABLE (finding B)', async () => {
    const userless = [{ ...REAL_REVIEWS[0], user: undefined }];
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS,
      eventPath: eventFile({ repository: { full_name: 'JKHeadley/instar', owner: { type: 'User' } } }),
      fetchImpl: fetchReturning(userless),
    });
    expect(r).toMatchObject({ available: false, reason: 'event-payload-shape' });
  });

  it('a userless review against a well-formed owner is skipped, not matched', async () => {
    const userless = [{ ...REAL_REVIEWS[0], user: undefined }];
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventPath: eventFile(), fetchImpl: fetchReturning(userless),
    });
    expect(r).toMatchObject({ available: true, accepted: false, reason: 'no-review-on-head-commit' });
  });

  it('a pull_request_review event is a valid context', async () => {
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, eventName: 'pull_request_review', eventPath: eventFile(), fetchImpl: fetchReturning(REAL_REVIEWS),
    });
    expect(r).toMatchObject({ available: true, accepted: true });
  });

  it('an empty-string token is UNAVAILABLE', async () => {
    const r = await verifyGithubReviewApproval({
      ...BASE_ARGS, token: '', eventPath: eventFile(), fetchImpl: fetchReturning(REAL_REVIEWS),
    });
    expect(r).toMatchObject({ available: false, reason: 'no-token' });
  });

  it('no event context (local run) is UNAVAILABLE', async () => {
    const r = await verifyGithubReviewApproval({
      eventName: undefined, eventPath: undefined, token: undefined, fetchImpl: fetchReturning([]),
    });
    expect(r).toMatchObject({ available: false, reason: 'no-github-event-context' });
  });
});

describe('applyGithubReviewRatification', () => {
  const ACCEPTED = {
    available: true, accepted: true,
    approval: { login: OWNER_LOGIN, commitId: HEAD_SHA, submittedAt: REAL_REVIEWS[0].submitted_at, reviewId: 1 },
  };

  // PRODUCTION SHAPE, deliberately (second-pass finding A): serialized changes
  // carry articleId/change and approvedBy NORMALIZED TO NULL — the first
  // version of this test hand-built { id, kind } with approvedBy absent, which
  // let a marking discriminator that never fires in production pass its test.
  function assessed(
    errors: string[],
    changes: object[] = [{ articleId: 'x', name: 'X', change: 'add', direction: null, approvedBy: null }],
  ) {
    return { status: 'not-proven', errors: [...errors], changes: changes.map((c) => ({ ...c })) };
  }

  it('clears ONLY the unsigned-ratification class and stamps the CLEARED article', () => {
    const a = assessed([
      'ADDITION "X" (x) requires an independently signed direction ratification',
    ]);
    const out = applyGithubReviewRatification(a, ACCEPTED);
    expect(out).toEqual({ applied: true, cleared: 1 });
    expect(a.status).toBe('passed');
    expect(a.errors).toEqual([]);
    expect(a.changes[0]).toMatchObject({ ratifiedVia: 'github-code-owner-review', approvedBy: OWNER_LOGIN });
  });

  it('INTEGRATION SHAPE: marks the article on REAL evaluateStandardsDirection output', () => {
    // The test that would have caught finding A: run the real evaluator on a
    // real add (no ledger entry), then apply the review to ITS serialized output.
    const base = '## Building — engineering discipline\n\n### Old Rule\n**Article ID.** `old-rule`\n**Rule.** Stays.\n';
    const cand = base + '\n### New Rule\n**Article ID.** `new-rule`\n**Rule.** Added.\n';
    const assessedReal = evaluateStandardsDirection({ baseMarkdown: base, candidateMarkdown: cand });
    expect(assessedReal.errors.some((e: string) => /requires an independently signed direction ratification$/.test(e))).toBe(true);
    const serialized = JSON.parse(JSON.stringify(assessedReal));
    const out = applyGithubReviewRatification(serialized, ACCEPTED);
    expect(out.applied).toBe(true);
    const marked = serialized.changes.find((c: { articleId: string }) => c.articleId === 'new-rule');
    expect(marked).toMatchObject({ ratifiedVia: 'github-code-owner-review', approvedBy: OWNER_LOGIN });
    expect(serialized.status).toBe('passed');
  });

  it('an article whose error STANDS keeps approvedBy null — the report cannot contradict itself', () => {
    const a = assessed(
      [
        'ADDITION "X" (x) requires an independently signed direction ratification',
        'STRENGTHEN "Y" lacks a valid different-principal signature',
      ],
      [
        { articleId: 'x', name: 'X', change: 'add', direction: null, approvedBy: null },
        { articleId: 'y', name: 'Y', change: 'edit', direction: null, approvedBy: null },
      ],
    );
    applyGithubReviewRatification(a, ACCEPTED);
    expect(a.changes[0]).toMatchObject({ ratifiedVia: 'github-code-owner-review' });
    expect(a.changes[1].approvedBy).toBeNull();
    expect((a.changes[1] as { ratifiedVia?: string }).ratifiedVia).toBeUndefined();
  });

  it('a forged/invalid signature error STANDS — the review does not paper over it', () => {
    const a = assessed([
      'ADDITION "X" (x) requires an independently signed direction ratification',
      'STRENGTHEN "Y" lacks a valid different-principal signature',
    ]);
    const out = applyGithubReviewRatification(a, ACCEPTED);
    expect(out.cleared).toBe(1);
    expect(a.status).toBe('not-proven');
    expect(a.errors).toEqual(['STRENGTHEN "Y" lacks a valid different-principal signature']);
  });

  it('does nothing without an accepted review', () => {
    const a = assessed(['ADDITION "X" (x) requires an independently signed direction ratification']);
    const out = applyGithubReviewRatification(a, { available: true, accepted: false, reason: 'nope' });
    expect(out).toEqual({ applied: false, cleared: 0 });
    expect(a.errors.length).toBe(1);
    expect(a.status).toBe('not-proven');
  });
});

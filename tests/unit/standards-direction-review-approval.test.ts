// Path B of the constitutional direction guard: an approving GitHub review from
// the repository owner, as an alternative to an Ed25519 ratification.
//
// WHY PATH B EXISTS. Path A requires the operator to create, guard and use a
// private key from a laptop. That key was never created, so no registry change
// merged between the guard landing (2026-08-17) and 2026-08-22. A guard nobody
// can satisfy blocks the work rather than the risk.
//
// WHAT THESE TESTS DO AND DO NOT ESTABLISH. They pin the DECISION LOGIC. They
// cannot establish that the gate is unremovable — the agent authors this file.
// That property lives in the repository ruleset (require-PR + CODEOWNERS naming
// the operator on docs/STANDARDS-REGISTRY.md), which needs admin rights the
// agent does not hold, and its evidence is the live platform configuration, not
// a passing suite. Said here so green does not imply more than it means.
//
// Every arm is tested in BOTH directions, because a gate that only ever passes
// is indistinguishable from no gate.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain-JS gate script, no type declarations
import { evaluateOperatorReviewApproval, evaluateStandardsDirection } from '../../scripts/standards-direction-guard.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const OWNER = 'JKHeadley';
const AGENT = 'EchoOfDawn';

const ctx = (over: Record<string, unknown> = {}) => ({
  ownerLogin: OWNER, ownerType: 'User', headSha: HEAD, prAuthorLogin: AGENT, reviews: [], ...over,
});
const review = (state: string, commit = HEAD, at = '2026-08-22T10:00:00Z', login = OWNER) =>
  ({ user: { login }, state, commit_id: commit, submitted_at: at });

describe('direction guard — path B (operator review approval)', () => {
  it('ACCEPTS an APPROVED review from the owner on the current head', () => {
    const r = evaluateOperatorReviewApproval(ctx({ reviews: [review('APPROVED')] }));
    expect(r.approved).toBe(true);
    expect(r.approvedBy).toBe(OWNER);
  });

  it('REFUSES an approval that was given against an earlier commit', () => {
    // The content-binding arm: approving text and then changing it must not
    // carry the approval forward.
    const r = evaluateOperatorReviewApproval(ctx({ reviews: [review('APPROVED', OTHER)] }));
    expect(r.approved).toBe(false);
    expect(r.reason).toContain('earlier commit');
  });

  it('REFUSES once the owner withdraws with CHANGES_REQUESTED afterwards', () => {
    const r = evaluateOperatorReviewApproval(ctx({
      reviews: [review('APPROVED', HEAD, '2026-08-22T10:00:00Z'), review('CHANGES_REQUESTED', HEAD, '2026-08-22T11:00:00Z')],
    }));
    expect(r.approved).toBe(false);
    expect(r.reason).toContain('withdrew');
  });

  it('REFUSES a DISMISSED approval', () => {
    const r = evaluateOperatorReviewApproval(ctx({
      reviews: [review('APPROVED', HEAD, '2026-08-22T10:00:00Z'), review('DISMISSED', HEAD, '2026-08-22T11:00:00Z')],
    }));
    expect(r.approved).toBe(false);
  });

  it('ACCEPTS a re-approval given AFTER an earlier objection', () => {
    // The other direction of the withdrawal rule: the LAST word wins, so a
    // resolved objection must not block forever.
    const r = evaluateOperatorReviewApproval(ctx({
      reviews: [review('CHANGES_REQUESTED', HEAD, '2026-08-22T10:00:00Z'), review('APPROVED', HEAD, '2026-08-22T11:00:00Z')],
    }));
    expect(r.approved).toBe(true);
  });

  it('REFUSES a review from anyone who is not the owner', () => {
    const r = evaluateOperatorReviewApproval(ctx({ reviews: [review('APPROVED', HEAD, '2026-08-22T10:00:00Z', 'SomeoneElse')] }));
    expect(r.approved).toBe(false);
  });

  it('REFUSES self-approval when the owner is also the pull request author', () => {
    const r = evaluateOperatorReviewApproval(ctx({ prAuthorLogin: OWNER, reviews: [review('APPROVED')] }));
    expect(r.approved).toBe(false);
    expect(r.reason).toContain('self-approval');
  });

  it('REFUSES a COMMENTED review (an opinion is not an approval)', () => {
    const r = evaluateOperatorReviewApproval(ctx({ reviews: [review('COMMENTED')] }));
    expect(r.approved).toBe(false);
  });

  it('is UNAVAILABLE on an organization-owned repository, never permissive', () => {
    // An organization names no individual. Falling back to an in-repo allowlist
    // would reintroduce a trust root the agent can edit.
    const r = evaluateOperatorReviewApproval(ctx({ ownerType: 'Organization', reviews: [review('APPROVED')] }));
    expect(r.approved).toBe(false);
    expect(r.reason).toContain('not an individual');
  });

  it.each([
    ['a missing review list', { reviews: null }],
    ['a malformed head sha', { headSha: 'not-a-sha' }],
    ['an absent owner login', { ownerLogin: '' }],
    ['an unparseable review timestamp', { reviews: [review('APPROVED', HEAD, 'whenever')] }],
  ])('FAILS CLOSED on %s', (_label, over) => {
    expect(evaluateOperatorReviewApproval(ctx(over)).approved).toBe(false);
  });
});

describe('direction guard — path B composed with the article decision', () => {
  const base = '## Fam\n\n### A\n**Rule.** one\n';
  const cand = '## Fam\n\n### A\n**Rule.** two\n';

  it('lets an owner approval satisfy a changed article', () => {
    const r = evaluateStandardsDirection({
      baseMarkdown: base, candidateMarkdown: cand,
      reviewApproval: { approved: true, approvedBy: OWNER, reason: 'ok' },
    });
    expect(r.status).toBe('passed');
    expect(r.changes[0].approvedVia).toBe('github-review');
    expect(r.changes[0].approvedBy).toBe(OWNER);
  });

  it('REFUSES when there is no approval and no signature', () => {
    const r = evaluateStandardsDirection({ baseMarkdown: base, candidateMarkdown: cand, reviewApproval: null });
    expect(r.status).toBe('not-proven');
    expect(r.errors.join(' ')).toContain("requires the operator's approving review");
  });

  it('treats an UNAVAILABLE review context as not-approved and names why', () => {
    // The distinction that matters: "we could not check" must never read as
    // "nobody objected".
    const r = evaluateStandardsDirection({
      baseMarkdown: base, candidateMarkdown: cand,
      reviewApproval: { approved: false, approvedBy: null, reason: 'review list unavailable' },
    });
    expect(r.status).toBe('not-proven');
    expect(r.errors.join(' ')).toContain('review list unavailable');
  });

  it('does not fabricate a change to approve when the registry is unchanged', () => {
    const r = evaluateStandardsDirection({
      baseMarkdown: base, candidateMarkdown: base,
      reviewApproval: { approved: true, approvedBy: OWNER, reason: 'ok' },
    });
    expect(r.status).toBe('passed');
    expect(r.changes).toEqual([]);
  });
});

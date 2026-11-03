/**
 * safe-merge code-owner review read from the reviews themselves.
 *
 * With a ruleset of `require_code_owner_review: true` and
 * `required_approving_review_count: 0`, GitHub leaves `reviewDecision` empty even
 * after the code owner approves (PR #2389, 2026-10-26), so safe-merge refused
 * every code-owned PR forever. When the decision is empty, safe-merge now decides
 * from the PR's reviews; a set decision keeps the old behaviour. Both sides of
 * every boundary are covered here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  codeOwnerApprovalFromReviews,
  codeOwnerReviewPending,
  isEmptyReviewDecision,
  ownersForFile,
  extractRulesetReviewPolicy,
} from '../../scripts/safe-merge.mjs';
import { parseCodeowners } from '../../scripts/local-verify-floor.mjs';

const RULES = parseCodeowners('docs/STANDARDS-REGISTRY.md   @JKHeadley\n.github/CODEOWNERS           @JKHeadley\n');
const HEAD = '6648d9f107ebf9a7ea17160f1389213f80bf3e97';
const OLD = '1111111111111111111111111111111111111111';
const OWNED = ['docs/STANDARDS-REGISTRY.md'];
const AUTHOR = 'EchoOfDawn';

const review = (login: string, state: string, commit: string, at: string) => ({
  user: { login }, state, commit_id: commit, submitted_at: at,
});
const decide = (reviews: unknown[], extra: Record<string, unknown> = {}) =>
  codeOwnerApprovalFromReviews({ ownedFiles: OWNED, rules: RULES, reviews, headSha: HEAD, excludeLogins: [AUTHOR], canWrite: () => true, ...extra });

describe('codeOwnerApprovalFromReviews', () => {
  it('passes when the code owner approved the current head (the #2389 shape)', () => {
    const v = decide([review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')]);
    expect(v.satisfied).toBe(true);
    expect(v.approvedBy).toEqual(['jkheadley']);
  });

  it('matches owner logins case-insensitively', () => {
    expect(decide([review('jkheadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')]).satisfied).toBe(true);
  });

  it('refuses an approval on an older commit (stale review never counts)', () => {
    const v = decide([review('JKHeadley', 'APPROVED', OLD, '2026-10-27T00:40:29Z')]);
    expect(v.satisfied).toBe(false);
    expect(v.reason).toBe('no-current-owner-approval');
    expect(v.unsatisfiedFiles).toEqual(OWNED);
  });

  it('refuses an approval from someone who is not a code owner', () => {
    expect(decide([review('someone-else', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')]).satisfied).toBe(false);
  });

  it('refuses when the owner later requested changes', () => {
    const v = decide([
      review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z'),
      review('JKHeadley', 'CHANGES_REQUESTED', HEAD, '2026-10-27T01:00:00Z'),
    ]);
    expect(v.satisfied).toBe(false);
  });

  it('orders by submitted_at, not by array position', () => {
    const v = decide([
      review('JKHeadley', 'CHANGES_REQUESTED', HEAD, '2026-10-27T01:00:00Z'),
      review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z'),
    ]);
    expect(v.satisfied).toBe(false);
  });

  it('a later COMMENTED review does not undo an approval, a later DISMISSED does', () => {
    const approved = review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z');
    expect(decide([approved, review('JKHeadley', 'COMMENTED', HEAD, '2026-10-27T01:00:00Z')]).satisfied).toBe(true);
    expect(decide([approved, review('JKHeadley', 'DISMISSED', HEAD, '2026-10-27T01:00:00Z')]).satisfied).toBe(false);
  });

  it('refuses the author approving their own PR, even if the author is a code owner', () => {
    const v = codeOwnerApprovalFromReviews({
      ownedFiles: OWNED, rules: parseCodeowners('docs/STANDARDS-REGISTRY.md @EchoOfDawn\n'),
      reviews: [review('EchoOfDawn', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')], headSha: HEAD, excludeLogins: [AUTHOR], canWrite: () => true,
    });
    expect(v.satisfied).toBe(false);
  });

  it('refuses an approval from the account running the merge (excluded login)', () => {
    expect(decide([review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')], { excludeLogins: [AUTHOR, 'JKHeadley'] }).satisfied).toBe(false);
  });

  it('needs an owner approval for EVERY owned file', () => {
    const rules = parseCodeowners('docs/STANDARDS-REGISTRY.md @JKHeadley\n.github/CODEOWNERS @other-owner\n');
    const v = codeOwnerApprovalFromReviews({
      ownedFiles: ['docs/STANDARDS-REGISTRY.md', '.github/CODEOWNERS'], rules,
      reviews: [review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')], headSha: HEAD, excludeLogins: [AUTHOR], canWrite: () => true,
    });
    expect(v.satisfied).toBe(false);
    expect(v.unsatisfiedFiles).toEqual(['.github/CODEOWNERS']);
  });

  it('a team-only owner cannot be resolved and keeps refusing with a named reason', () => {
    const rules = parseCodeowners('docs/STANDARDS-REGISTRY.md @JKHeadley-org/maintainers\n');
    const v = codeOwnerApprovalFromReviews({
      ownedFiles: OWNED, rules, reviews: [review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')], headSha: HEAD, excludeLogins: [AUTHOR], canWrite: () => true,
    });
    expect(v.satisfied).toBe(false);
    expect(v.reason).toBe('owner-unresolvable');
    expect(v.unresolvableOwners).toEqual(['@JKHeadley-org/maintainers']);
  });

  it('a user owner alongside a team still satisfies the file', () => {
    const rules = parseCodeowners('docs/STANDARDS-REGISTRY.md @org/team @JKHeadley\n');
    const v = codeOwnerApprovalFromReviews({
      ownedFiles: OWNED, rules, reviews: [review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')], headSha: HEAD, excludeLogins: [AUTHOR], canWrite: () => true,
    });
    expect(v.satisfied).toBe(true);
  });

  it('refuses with no reviews, no owned files, or an unknown head', () => {
    expect(decide([]).satisfied).toBe(false);
    expect(codeOwnerApprovalFromReviews({ ownedFiles: [], rules: RULES, reviews: [], headSha: HEAD }).satisfied).toBe(false);
    expect(decide([review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')], { headSha: null }).satisfied).toBe(false);
  });

  it('refuses an owner approval when the owner lacks write access (GitHub ignores it), and by default', () => {
    const r = [review('JKHeadley', 'APPROVED', HEAD, '2026-10-27T00:40:29Z')];
    expect(decide(r, { canWrite: () => false }).satisfied).toBe(false);
    expect(codeOwnerApprovalFromReviews({ ownedFiles: OWNED, rules: RULES, reviews: r, headSha: HEAD, excludeLogins: [AUTHOR] }).satisfied).toBe(false);
  });

  it('ownersForFile uses the last matching rule', () => {
    const rules = parseCodeowners('docs/** @a\ndocs/STANDARDS-REGISTRY.md @b\n');
    expect(ownersForFile('docs/STANDARDS-REGISTRY.md', rules)).toEqual(['@b']);
    expect(ownersForFile('src/x.ts', rules)).toEqual([]);
  });
});

describe('the reviewDecision paths that are unchanged', () => {
  const policy = extractRulesetReviewPolicy([{ type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true } }]);

  it('only an empty decision falls through to the reviews', () => {
    expect(isEmptyReviewDecision(null)).toBe(true);
    expect(isEmptyReviewDecision(undefined)).toBe(true);
    expect(isEmptyReviewDecision('')).toBe(true);
    expect(isEmptyReviewDecision('APPROVED')).toBe(false);
    expect(isEmptyReviewDecision('REVIEW_REQUIRED')).toBe(false);
    expect(isEmptyReviewDecision('CHANGES_REQUESTED')).toBe(false);
  });

  it('APPROVED still passes and REVIEW_REQUIRED still holds without reading reviews', () => {
    expect(codeOwnerReviewPending({ policy, ownedFiles: OWNED, reviewDecision: 'APPROVED' })).toBe(false);
    expect(codeOwnerReviewPending({ policy, ownedFiles: OWNED, reviewDecision: 'REVIEW_REQUIRED' })).toBe(true);
    expect(codeOwnerReviewPending({ policy, ownedFiles: OWNED, reviewDecision: '' })).toBe(true);
  });
});

describe('wiring', () => {
  it('reviewPrecheck consults the reviews only when GitHub left the decision empty', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/safe-merge.mjs'), 'utf8');
    const body = src.slice(src.indexOf('function reviewPrecheck('), src.indexOf('export function isEmptyReviewDecision'));
    expect(body).toMatch(/if \(isEmptyReviewDecision\(view\.reviewDecision\)\) \{[\s\S]*fetchPrReviews\(repo, pr\)[\s\S]*codeOwnerApprovalFromReviews\(/);
    expect(body).toMatch(/excludeLogins: \[view\.author\?\.login, fetchViewerLogin\(\)\]/);
    expect(body).toMatch(/canWrite: \(login\) => hasWriteAccess\(repo, login\)/);
  });
});

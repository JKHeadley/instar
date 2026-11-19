/**
 * Approval fact + the PR-link hook asking only where an approval may be needed
 * (Echo Bugs topic 10000002791, spec docs/specs/approval-asks-only-where-required.md).
 *
 * The founding case: PR #3326 touched no code-owned file on a repository whose
 * ruleset requires no review, yet the hook made the operator a requested reviewer
 * seconds after it opened. Both sides of every boundary of the decision are
 * covered, every unread input lands on 'unknown', and the hook keeps today's
 * request for every answer except an exact 'not-required'.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  approvalRequirement, readPrApprovalFact, KNOWN_PULL_REQUEST_PARAMS, PR_FILES_CAP, type ApprovalInputs,
} from '../../src/messaging/prApprovalFact.js';
import { ensureReviewerOnPr } from '../../src/messaging/prLinkReviewRequest.js';
import type { AuthenticatedGhExec } from '../../src/core/githubRuntime.js';

const CODEOWNERS = '# the constitution\ndocs/STANDARDS-REGISTRY.md   @JKHeadley\n.github/CODEOWNERS           @JKHeadley\n';
/** The live instar-main-protection pull_request rule (2026-11-17). */
const LIVE_PR_RULE = {
  type: 'pull_request',
  parameters: {
    allowed_merge_methods: ['merge', 'squash', 'rebase'], dismiss_stale_reviews_on_push: true,
    require_code_owner_review: true, require_extra_approval_for_unattributed_changes: true,
    require_last_push_approval: false, required_approving_review_count: 0,
    required_review_thread_resolution: false, required_reviewers: [],
  },
};
const base = (over: Partial<ApprovalInputs> = {}): ApprovalInputs => ({
  rules: [{ type: 'deletion' }, LIVE_PR_RULE, { type: 'required_status_checks', parameters: {} }],
  reviewDecision: null, codeowners: CODEOWNERS, files: ['src/core/SessionManager.ts', 'dashboard/index.html'],
  ...over,
});
const withParams = (p: Record<string, unknown>) => [{ type: 'pull_request', parameters: { ...LIVE_PR_RULE.parameters, ...p } }];

describe('approvalRequirement', () => {
  it('the #3326 shape (live ruleset, no code-owned file) is not-required', () => {
    expect(approvalRequirement(base()).requirement).toBe('not-required');
  });

  it('a code-owned file touched is required', () => {
    expect(approvalRequirement(base({ files: ['src/x.ts', 'docs/STANDARDS-REGISTRY.md'] }))).toMatchObject({ requirement: 'required' });
  });

  it('any rule requiring a general approval is required', () => {
    expect(approvalRequirement(base({ rules: withParams({ required_approving_review_count: 1 }) })).requirement).toBe('required');
    expect(approvalRequirement(base({ rules: withParams({ require_last_push_approval: true }) })).requirement).toBe('required');
    expect(approvalRequirement(base({ rules: withParams({ required_reviewers: [{ reviewer: { id: 1 } }] }) })).requirement).toBe('required');
  });

  it('a parameter it does not understand is unknown, and names the parameter', () => {
    const r = approvalRequirement(base({ rules: withParams({ require_quantum_signoff: true }) }));
    expect(r).toMatchObject({ requirement: 'unknown' });
    expect(r.reason).toContain('require_quantum_signoff');
    expect(KNOWN_PULL_REQUEST_PARAMS.has('require_extra_approval_for_unattributed_changes')).toBe(true);
  });

  it('classic protection: any non-null review decision is required; unread is unknown', () => {
    expect(approvalRequirement(base({ reviewDecision: 'REVIEW_REQUIRED' })).requirement).toBe('required');
    expect(approvalRequirement(base({ reviewDecision: 'APPROVED' })).requirement).toBe('required');
    expect(approvalRequirement(base({ reviewDecision: undefined })).requirement).toBe('unknown');
  });

  it('a repository with no code-owner review rule is ungoverned (callers keep today\'s behaviour)', () => {
    expect(approvalRequirement(base({ rules: [] })).requirement).toBe('ungoverned');
    expect(approvalRequirement(base({ rules: withParams({ require_code_owner_review: false }) })).requirement).toBe('ungoverned');
  });

  it('every unread or truncated input is unknown, never not-required', () => {
    expect(approvalRequirement(base({ rules: null })).requirement).toBe('unknown');
    expect(approvalRequirement(base({ codeowners: undefined })).requirement).toBe('unknown');
    expect(approvalRequirement(base({ codeowners: null })).requirement).toBe('unknown');
    expect(approvalRequirement(base({ files: null })).requirement).toBe('unknown');
    expect(approvalRequirement(base({ files: Array.from({ length: PR_FILES_CAP }, (_, i) => `f${i}.ts`) })).requirement).toBe('unknown');
  });
});

/** A fake GitHub for the fact reads. */
function factGh(opts: {
  rules?: unknown; rulesFail?: string; decision?: unknown; graphqlFail?: boolean;
  codeowners?: Record<string, string>; codeownersFail?: boolean; files?: string[]; filesFail?: boolean;
} = {}) {
  const calls: string[][] = [];
  const gh: AuthenticatedGhExec = vi.fn(async (args: string[]) => {
    calls.push(args);
    const ok = (s: string) => ({ code: 0, stdout: s, stderr: '' });
    const p = args[1];
    if (p === 'graphql') {
      if (opts.graphqlFail) return { code: 1, stdout: '', stderr: 'gh: HTTP 502' };
      return ok(JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: opts.decision ?? null } } } }));
    }
    if (p.startsWith('repos/JKHeadley/instar/rules/branches/')) {
      if (opts.rulesFail) return { code: 1, stdout: '', stderr: opts.rulesFail };
      return ok(JSON.stringify(opts.rules ?? [LIVE_PR_RULE]));
    }
    if (p.startsWith('repos/JKHeadley/instar/contents/')) {
      if (opts.codeownersFail) return { code: 1, stdout: '', stderr: 'gh: HTTP 500' };
      const loc = p.slice('repos/JKHeadley/instar/contents/'.length).split('?')[0];
      const map = opts.codeowners ?? { '.github/CODEOWNERS': CODEOWNERS };
      return loc in map ? ok(map[loc]) : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    }
    if (p.startsWith('repos/JKHeadley/instar/pulls/3326/files')) {
      if (opts.filesFail) return { code: 1, stdout: '', stderr: 'gh: HTTP 502' };
      return ok((opts.files ?? ['src/core/SessionManager.ts']).join('\n') + '\n');
    }
    return { code: 1, stdout: '', stderr: `unexpected ${p}` };
  });
  return { gh, calls };
}
const ref3326 = { owner: 'JKHeadley', repo: 'instar', number: 3326 };

describe('readPrApprovalFact', () => {
  it('reads the four inputs and answers not-required for the founding case', async () => {
    const g = factGh();
    expect((await readPrApprovalFact(ref3326, 'main', g.gh)).requirement).toBe('not-required');
    // Renames are read by their previous path too.
    expect(g.calls.find((c) => c[1].includes('/files'))?.join(' ')).toContain('previous_filename');
  });

  it('follows GitHub\'s CODEOWNERS order: a root CODEOWNERS counts when .github has none', async () => {
    const g = factGh({ codeowners: { CODEOWNERS }, files: ['docs/STANDARDS-REGISTRY.md'] });
    expect((await readPrApprovalFact(ref3326, 'main', g.gh)).requirement).toBe('required');
  });

  it('no CODEOWNERS at any location with a code-owner rule is unknown; a non-404 read error is unknown', async () => {
    expect((await readPrApprovalFact(ref3326, 'main', factGh({ codeowners: {} }).gh)).requirement).toBe('unknown');
    expect((await readPrApprovalFact(ref3326, 'main', factGh({ codeownersFail: true }).gh)).requirement).toBe('unknown');
  });

  it('a 404 on rulesets is "no rulesets" (ungoverned); any other ruleset error is unknown', async () => {
    expect((await readPrApprovalFact(ref3326, 'main', factGh({ rulesFail: 'gh: Not Found (HTTP 404)' }).gh)).requirement).toBe('ungoverned');
    expect((await readPrApprovalFact(ref3326, 'main', factGh({ rulesFail: 'gh: HTTP 502' }).gh)).requirement).toBe('unknown');
  });

  it('a failed review-decision or file read is unknown; no base branch is unknown', async () => {
    expect((await readPrApprovalFact(ref3326, 'main', factGh({ graphqlFail: true }).gh)).requirement).toBe('unknown');
    expect((await readPrApprovalFact(ref3326, 'main', factGh({ filesFail: true }).gh)).requirement).toBe('unknown');
    expect((await readPrApprovalFact(ref3326, undefined, factGh().gh)).requirement).toBe('unknown');
  });
});

/** The hook's fake GitHub (the PR view + review request paths), with the fact injected. */
function hookGh() {
  const requested: string[] = [];
  const calls: string[][] = [];
  const gh: AuthenticatedGhExec = vi.fn(async (args: string[]) => {
    calls.push(args);
    const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
    const path = args[1] === '-X' ? args[3] : args[1];
    if (path === 'repos/JKHeadley/instar/pulls/3326') {
      return ok({ state: 'open', user: { login: 'EchoOfDawn' }, head: { sha: 'abc' }, requested_reviewers: [],
        base: { ref: 'main', repo: { owner: { login: 'JKHeadley', type: 'User' } } } });
    }
    if (path === 'repos/JKHeadley/instar/pulls/3326/reviews?per_page=100') return ok([]);
    if (path === 'repos/JKHeadley/instar/pulls/3326/requested_reviewers') {
      if (args[1] === '-X') { requested.push(args[5].replace('reviewers[]=', '')); return ok({}); }
      return ok({ users: requested.map((login) => ({ login })) });
    }
    return { code: 1, stdout: '', stderr: `unexpected ${path}` };
  });
  return { gh, calls, requested };
}
const self = async () => 'EchoOfDawn';

describe('ensureReviewerOnPr — only where an approval may be needed', () => {
  it('skips the request when the fact is not-required (the #3326 case), passing the held base branch', async () => {
    const g = hookGh();
    const approvalFact = vi.fn(async () => ({ requirement: 'not-required' as const, reason: 'no rule requires a review and no code-owned file is touched' }));
    const r = await ensureReviewerOnPr(ref3326, { gh: g.gh, selfLogin: self, approvalFact });
    expect(r.outcome).toBe('skipped-no-approval-required');
    expect(g.requested).toEqual([]);
    expect(approvalFact).toHaveBeenCalledWith(ref3326, 'main', g.gh);
    // The PR view is read once, never re-read for the fact.
    expect(g.calls.filter((c) => c[1] === 'repos/JKHeadley/instar/pulls/3326')).toHaveLength(1);
  });

  it.each(['required', 'unknown', 'ungoverned'] as const)('keeps today\'s request when the fact is %s', async (requirement) => {
    const g = hookGh();
    const r = await ensureReviewerOnPr(ref3326, { gh: g.gh, selfLogin: self, approvalFact: async () => ({ requirement, reason: 'x' }) });
    expect(r.outcome).toBe('requested');
    expect(g.requested).toEqual(['JKHeadley']);
  });

  it('requestWhenNotRequired restores always-request and does not read the fact', async () => {
    const g = hookGh();
    const approvalFact = vi.fn(async () => ({ requirement: 'not-required' as const, reason: 'x' }));
    const r = await ensureReviewerOnPr(ref3326, { gh: g.gh, selfLogin: self, approvalFact, requestWhenNotRequired: true });
    expect(r.outcome).toBe('requested');
    expect(approvalFact).not.toHaveBeenCalled();
  });

  it('a fact that does not answer in its budget is unknown, so the request is still made', async () => {
    const g = hookGh();
    const never = () => new Promise<never>(() => {});
    const r = await ensureReviewerOnPr(ref3326, { gh: g.gh, selfLogin: self, approvalFact: never, factBudgetMs: 20 });
    expect(r.outcome).toBe('requested');
    expect(r.approval).toMatchObject({ requirement: 'unknown' });
  });
});

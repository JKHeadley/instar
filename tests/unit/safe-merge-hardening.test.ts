/**
 * Tier-1 tests for the hardened safe-merge.mjs (green-pr-automerge-enforcement §3.1).
 * Pure-function coverage of both sides of every decision boundary: strict argv,
 * JSON checks classification (the `pending`-matches-name bug), required-contexts
 * cross-check with PRODUCER binding (missing / skipped / renamed / app-scoped /
 * matrix-expanded / wrong-producer / floor-missing), reviews-required, and honest
 * merge-failure classification (null status / signal / already-merged / closed).
 */

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  UsageError,
  capabilities,
  classifyChecks,
  evaluateRequiredContexts,
  classifyMergeFailure,
  isAutoMergeUnavailable,
  extractRulesetReviewPolicy,
  isNonPusherApprovalRequired,
  reviewUrlFor,
  CONTRACT_VERSION,
  DEFAULT_REPO,
  REQUIRED_CONTEXTS_FLOOR,
  CLASSIC_PROTECTION_CONTEXTS_PINNED,
  ACTIONS_FLOOR_CONTEXTS,
  LOCAL_VERIFY_CONTEXT,
  fetchProtectionContexts,
  extractBranchProtection,
  noActionsChecksRan,
} from '../../scripts/safe-merge.mjs';

describe('parseArgs — strict argv', () => {
  it('parses a typical watcher invocation', () => {
    const a = parseArgs(['1084', '--repo', 'JKHeadley/instar', '--squash', '--delete-branch', '--admin', '--match-head-commit', 'abc1234', '--deadline-ms', '90000']);
    expect(a.pr).toBe('1084');
    expect(a.repo).toBe('JKHeadley/instar');
    expect(a.method).toBe('--squash');
    expect(a.deleteBranch).toBe(true);
    expect(a.admin).toBe(true);
    expect(a.matchHeadCommit).toBe('abc1234');
    expect(a.deadlineMs).toBe(90000);
  });

  it('defaults repo/method/deadline when omitted', () => {
    const a = parseArgs(['42']);
    expect(a.repo).toBe(DEFAULT_REPO);
    expect(a.method).toBe('--merge');
    expect(a.admin).toBe(false);
    expect(a.deadlineMs).toBeGreaterThan(0);
  });

  it('REJECTS an unknown flag (the stale-caller drift the contract closes)', () => {
    expect(() => parseArgs(['42', '--force-yolo'])).toThrow(UsageError);
  });

  it('rejects a value flag without a value', () => {
    expect(() => parseArgs(['42', '--repo'])).toThrow(UsageError);
    expect(() => parseArgs(['42', '--repo', '--admin'])).toThrow(UsageError);
  });

  it('rejects a malformed repo / sha / deadline', () => {
    expect(() => parseArgs(['42', '--repo', 'not-a-repo'])).toThrow(UsageError);
    expect(() => parseArgs(['42', '--match-head-commit', 'zzz'])).toThrow(UsageError);
    expect(() => parseArgs(['42', '--deadline-ms', '-5'])).toThrow(UsageError);
  });

  it('requires a PR number unless --capabilities', () => {
    expect(() => parseArgs(['--squash'])).toThrow(UsageError);
    expect(parseArgs(['--capabilities']).capabilities).toBe(true);
  });

  it('rejects a duplicate PR number', () => {
    expect(() => parseArgs(['42', '43'])).toThrow(UsageError);
  });

  it('parses --extra-floor into a trimmed list', () => {
    const a = parseArgs(['42', '--extra-floor', 'Foo, Bar ,Baz']);
    expect(a.extraFloor).toEqual(['Foo', 'Bar', 'Baz']);
  });

  it('parses --auto (native auto-merge) and defaults it off', () => {
    expect(parseArgs(['42']).auto).toBe(false);
    const a = parseArgs(['1183', '--repo', 'JKHeadley/instar', '--squash', '--auto', '--delete-branch']);
    expect(a.auto).toBe(true);
    expect(a.admin).toBe(false);
    expect(a.method).toBe('--squash');
    expect(a.deleteBranch).toBe(true);
  });

  it('REJECTS --auto and --admin together (contradictory strategies)', () => {
    expect(() => parseArgs(['42', '--squash', '--auto', '--admin'])).toThrow(UsageError);
    expect(() => parseArgs(['42', '--squash', '--admin', '--auto'])).toThrow(UsageError);
  });
});

describe('parseArgs — --attempt-token (ACT-141: argv identity for orphan reap)', () => {
  it('accepts a hex token and records it without changing the merge', () => {
    const a = parseArgs(['5', '--squash', '--attempt-token', 'abcd1234abcd1234']);
    expect(a.attemptToken).toBe('abcd1234abcd1234');
    expect(a.method).toBe('--squash');
    expect(a.pr).toBe('5');
  });
  it('rejects a missing or non-hex value', () => {
    expect(() => parseArgs(['5', '--attempt-token'])).toThrow(/requires a value/);
    expect(() => parseArgs(['5', '--attempt-token', 'not-hex!'])).toThrow(/must be hex/);
  });
  it('advertises the attempt-token capability', () => {
    expect(capabilities().features).toContain('attempt-token');
  });
});

describe('capabilities — contract probe', () => {
  it('reports the contract version and feature set', () => {
    const c = capabilities();
    expect(c.contract).toBe(CONTRACT_VERSION);
    expect(c.features).toContain('head-pinning');
    expect(c.features).toContain('producer-binding');
    expect(c.features).toContain('native-auto-merge');
    expect(c.features).toContain('auto-arm-unavailable-detection');
    expect(c.exitCodes.merged).toBe(0);
    expect(c.exitCodes.autoMergeArmed).toBe(5);
  });
});

describe('isAutoMergeUnavailable — the repo-disabled discriminator (mergerunner-auto-arm-handoff)', () => {
  it('matches the GitHub "auto-merge not allowed/enabled" signatures', () => {
    expect(isAutoMergeUnavailable('Auto-merge is not allowed for this repository')).toBe(true);
    expect(isAutoMergeUnavailable('auto-merge is not enabled on this repo')).toBe(true);
    expect(isAutoMergeUnavailable('Please enable "Allow auto-merge" in repository settings')).toBe(true);
    expect(isAutoMergeUnavailable('GraphQL: Allow auto-merge must be enabled')).toBe(true);
  });
  it('does NOT match a generic transient gh failure (which stays a normal backoff refusal)', () => {
    expect(isAutoMergeUnavailable('error connecting to api.github.com')).toBe(false);
    expect(isAutoMergeUnavailable('HTTP 502 Bad Gateway')).toBe(false);
    expect(isAutoMergeUnavailable('')).toBe(false);
    expect(isAutoMergeUnavailable(undefined)).toBe(false);
  });
});

describe('noActionsChecksRan — zero checks is not green (PR #2302)', () => {
  it('no check runs at all → nothing ran', () => {
    expect(noActionsChecksRan([])).toBe(true);
    expect(noActionsChecksRan(undefined)).toBe(true);
  });
  it('only a Vercel check run → nothing ran', () => {
    expect(noActionsChecksRan([{ name: 'Vercel Preview Comments', conclusion: 'success', appSlug: 'vercel', workflowPath: null }])).toBe(true);
  });
  it('one GitHub Actions check run → checks ran', () => {
    expect(noActionsChecksRan([
      { name: 'Vercel Preview Comments', conclusion: 'success', appSlug: 'vercel', workflowPath: null },
      { name: 'Type Check', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' },
    ])).toBe(false);
  });
});

describe('classifyChecks — JSON bucket parsing', () => {
  it('does NOT treat a check NAMED with "pending" as pending (the round-1 bug)', () => {
    const s = classifyChecks([
      { name: 'block-pending-migrations', bucket: 'pass' },
      { name: 'E2E Tests', bucket: 'pass' },
    ]);
    expect(s.settled).toBe(true);
    expect(s.pending).toEqual([]);
    expect(s.failed).toEqual([]);
  });

  it('flags a genuinely pending bucket as unsettled', () => {
    const s = classifyChecks([{ name: 'Build', bucket: 'pending' }]);
    expect(s.settled).toBe(false);
    expect(s.pending).toContain('Build');
  });

  it('collects failed checks and recognizes e2e pass', () => {
    const s = classifyChecks([
      { name: 'Type Check', bucket: 'fail' },
      { name: 'E2E Tests', bucket: 'pass' },
    ]);
    expect(s.failed.length).toBe(1);
    expect(s.sawE2e).toBe(true);
    expect(s.e2ePassed).toBe(true);
  });

  it('treats skipping as ok but a present-then-not-pass e2e as not-passed', () => {
    const s = classifyChecks([
      { name: 'Optional Lint', bucket: 'skipping' },
      { name: 'E2E Tests', bucket: 'skipping' },
    ]);
    expect(s.failed).toEqual([]);
    expect(s.sawE2e).toBe(true);
    expect(s.e2ePassed).toBe(false);
  });
});

describe('evaluateRequiredContexts — producer-bound floor', () => {
  const floor = [
    { context: 'E2E Tests', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' },
  ];
  const goodRun = { name: 'E2E Tests', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' };

  it('passes when every required context has a producer-matched success', () => {
    const r = evaluateRequiredContexts({
      protectionContexts: [], rulesetContexts: [], floor, extraFloor: [],
      checkRuns: [goodRun],
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('refuses when a floor context is MISSING entirely', () => {
    const r = evaluateRequiredContexts({
      protectionContexts: [], rulesetContexts: [], floor, extraFloor: [],
      checkRuns: [{ name: 'Build', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' }],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/E2E Tests.*no genuinely-successful/);
  });

  it('refuses a SKIPPED required context (skipped on a required check = refusal)', () => {
    const r = evaluateRequiredContexts({
      protectionContexts: [], rulesetContexts: [], floor, extraFloor: [],
      checkRuns: [{ ...goodRun, conclusion: 'skipped' }],
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a WRONG-PRODUCER lookalike (right name, tampered workflow path)', () => {
    const r = evaluateRequiredContexts({
      protectionContexts: [], rulesetContexts: [], floor, extraFloor: [],
      checkRuns: [{ name: 'E2E Tests', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/evil.yml' }],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/WRONG producer/);
  });

  it('refuses a WRONG-APP lookalike (right name + path, foreign app slug)', () => {
    const r = evaluateRequiredContexts({
      protectionContexts: [], rulesetContexts: [], floor, extraFloor: [],
      checkRuns: [{ name: 'E2E Tests', conclusion: 'success', appSlug: 'malicious-app', workflowPath: '.github/workflows/ci.yml' }],
    });
    expect(r.ok).toBe(false);
  });

  it('unions branch-protection contexts (matrix-expanded shards) into the requirement', () => {
    const shards = ['Unit Tests (node 20, shard 1/4)', 'Unit Tests (node 20, shard 2/4)'];
    const r = evaluateRequiredContexts({
      protectionContexts: shards, rulesetContexts: [], floor, extraFloor: [],
      checkRuns: [goodRun, { name: shards[0], conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' }],
    });
    expect(r.ok).toBe(false); // shard 2 missing
    expect(r.problems.join(' ')).toMatch(/shard 2\/4/);
  });

  it('honors a name-only extraFloor extension', () => {
    const r = evaluateRequiredContexts({
      protectionContexts: [], rulesetContexts: [], floor, extraFloor: ['Custom Gate'],
      checkRuns: [goodRun],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/Custom Gate/);
  });

  it('accepts an app-scoped floor pin when appSlug matches and path pin is absent', () => {
    const appOnlyFloor = [{ context: 'E2E Tests', appSlug: 'github-actions' }];
    const r = evaluateRequiredContexts({
      protectionContexts: [], rulesetContexts: [], floor: appOnlyFloor, extraFloor: [],
      checkRuns: [{ name: 'E2E Tests', conclusion: 'success', appSlug: 'github-actions', workflowPath: null }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('classifyMergeFailure — honest exits', () => {
  it('classifies an already-merged race', () => {
    expect(classifyMergeFailure('Pull request already merged', 1, null)).toBe('already-merged');
  });
  it('classifies a closed PR', () => {
    expect(classifyMergeFailure('pull request 42 is closed', 1, null)).toBe('closed');
  });
  it('classifies a signal kill as an error, never success', () => {
    expect(classifyMergeFailure('', null, 'SIGKILL')).toBe('error:signal-SIGKILL');
  });
  it('classifies a null spawn status as an error', () => {
    expect(classifyMergeFailure('', null, null)).toBe('error:null-status');
  });
  it('classifies a generic non-zero merge as a command failure', () => {
    expect(classifyMergeFailure('some other gh error', 1, null)).toBe('error:merge-command-failed');
  });
});

describe('REQUIRED_CONTEXTS_FLOOR — code-pinned minimum', () => {
  it('pins the gate contexts with producers (name-match alone is insufficient)', () => {
    const names = REQUIRED_CONTEXTS_FLOOR.map(f => f.context);
    expect(names).toContain('E2E Tests');
    expect(names).toContain('eli16');
    expect(names).toContain('decision-audit');
    for (const pin of REQUIRED_CONTEXTS_FLOOR) {
      expect(pin.workflowPath).toMatch(/^\.github\/workflows\//);
      expect(pin.appSlug).toBeTruthy();
    }
  });
});

describe('ruleset review policy — request the approval up front, never a reviewer-less dead end (2026-08-22)', () => {
  // Verbatim shape of GET /repos/JKHeadley/instar/rules/branches/main after the
  // 2026-08-22 17:03 PDT ruleset change: 0 required approvals but
  // require_last_push_approval:true. The wrapper read only classic protection,
  // declared PR #1963 mergeable, and GitHub refused the merge — leaving the
  // operator with "waiting for someone to request your review".
  const RULES = [
    { type: 'deletion', ruleset_id: 1 },
    { type: 'required_status_checks', ruleset_id: 1, parameters: { required_status_checks: [{ context: 'e2e' }] } },
    { type: 'pull_request', ruleset_id: 1, parameters: { required_approving_review_count: 0, require_last_push_approval: true, dismiss_stale_reviews_on_push: false } },
  ];

  it('detects require_last_push_approval even with zero required approvals', () => {
    expect(extractRulesetReviewPolicy(RULES)).toEqual({ reviewsRequired: false, lastPushApprovalRequired: true });
  });

  it('detects a positive required_approving_review_count', () => {
    const rules = [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }];
    expect(extractRulesetReviewPolicy(rules)).toEqual({ reviewsRequired: true, lastPushApprovalRequired: false });
  });

  it('reports no policy when there is no pull_request rule (the pre-change state) — no over-block', () => {
    expect(extractRulesetReviewPolicy(RULES.filter(r => r.type !== 'pull_request'))).toEqual({ reviewsRequired: false, lastPushApprovalRequired: false });
    expect(extractRulesetReviewPolicy([])).toEqual({ reviewsRequired: false, lastPushApprovalRequired: false });
    expect(extractRulesetReviewPolicy(null)).toEqual({ reviewsRequired: false, lastPushApprovalRequired: false });
  });

  it("matches GitHub's verbatim non-pusher refusal on the merge path", () => {
    expect(isNonPusherApprovalRequired('GraphQL: Repository rule violations found\nNew changes require approval from someone other than the last pusher.\n (mergePullRequest)')).toBe(true);
  });

  it('does NOT match an unrelated merge failure (stays a normal merge-command-failed)', () => {
    expect(isNonPusherApprovalRequired('GraphQL: Pull request is not mergeable (mergePullRequest)')).toBe(false);
    expect(isNonPusherApprovalRequired('')).toBe(false);
  });

  it('the review link is the Files tab, where Review changes → Approve lives', () => {
    expect(reviewUrlFor('JKHeadley/instar', 1963)).toBe('https://github.com/JKHeadley/instar/pull/1963/files');
  });

  it('parseArgs accepts --request-review-from as a login list and rejects junk', () => {
    expect(parseArgs(['1963', '--squash', '--admin', '--request-review-from', 'JKHeadley,octocat']).requestReviewFrom).toEqual(['JKHeadley', 'octocat']);
    expect(parseArgs(['1963']).requestReviewFrom).toEqual([]);
    expect(() => parseArgs(['1963', '--request-review-from', 'not a login!'])).toThrow(UsageError);
  });

  it('advertises the new capabilities so the orchestrator can key on the slug', () => {
    const caps = capabilities();
    expect(caps.features).toContain('approval-required-refusal');
    expect(caps.features).toContain('request-review-from');
  });
});

describe('ACTIONS_FLOOR_CONTEXTS — one shared floor incl. the 12 classic-protection contexts (local-verify-merge-authority §3)', () => {
  const CLASSIC_12 = [
    'Type Check', 'Integration Tests', 'E2E Tests', 'Build',
    'Unit Tests (node 20, shard 1/4)', 'Unit Tests (node 20, shard 2/4)', 'Unit Tests (node 20, shard 3/4)', 'Unit Tests (node 20, shard 4/4)',
    'Unit Tests (node 22, shard 1/4)', 'Unit Tests (node 22, shard 2/4)', 'Unit Tests (node 22, shard 3/4)', 'Unit Tests (node 22, shard 4/4)',
  ];

  it('pins exactly the 12 classic contexts, each bound to ci.yml + github-actions', () => {
    expect(CLASSIC_PROTECTION_CONTEXTS_PINNED.map(p => p.context)).toEqual(CLASSIC_12);
    for (const pin of CLASSIC_PROTECTION_CONTEXTS_PINNED) {
      expect(pin.workflowPath).toBe('.github/workflows/ci.yml');
      expect(pin.appSlug).toBe('github-actions');
    }
  });

  it('is REQUIRED_CONTEXTS_FLOOR plus the 12, deduplicated, without instar/local-verify', () => {
    const names = ACTIONS_FLOOR_CONTEXTS.map(p => p.context);
    for (const n of [...REQUIRED_CONTEXTS_FLOOR.map(f => f.context), ...CLASSIC_12]) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(LOCAL_VERIFY_CONTEXT);
    expect(names.length).toBe(14); // 6 floor + 8 unit shards (4 classic already in the floor)
  });

  it('refuses a merge whose unit shards never ran, even when protection lists nothing', () => {
    const runs = REQUIRED_CONTEXTS_FLOOR.map(f => ({ name: f.context, conclusion: 'success', appSlug: f.appSlug, workflowPath: f.workflowPath }));
    const r = evaluateRequiredContexts({ protectionContexts: [], rulesetContexts: [], floor: ACTIONS_FLOOR_CONTEXTS, extraFloor: [], checkRuns: runs });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/Unit Tests \(node 22, shard 4\/4\)/);
  });

  it('refuses a unit shard from the wrong producer', () => {
    const runs = ACTIONS_FLOOR_CONTEXTS.map(f => ({ name: f.context, conclusion: 'success', appSlug: f.appSlug,
      workflowPath: f.context.startsWith('Unit Tests (node 20, shard 1') ? '.github/workflows/evil.yml' : f.workflowPath }));
    const r = evaluateRequiredContexts({ protectionContexts: [], rulesetContexts: [], floor: ACTIONS_FLOOR_CONTEXTS, extraFloor: [], checkRuns: runs });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/WRONG producer/);
  });
});

describe('instar/local-verify is read from combined statuses, never check runs', () => {
  const allGreenRuns = ACTIONS_FLOOR_CONTEXTS.map(f => ({ name: f.context, conclusion: 'success', appSlug: f.appSlug, workflowPath: f.workflowPath }));
  const base = { protectionContexts: [], rulesetContexts: [LOCAL_VERIFY_CONTEXT], floor: ACTIONS_FLOOR_CONTEXTS, extraFloor: [], checkRuns: allGreenRuns };

  it('an Actions-floor merge succeeds when the required status is success (the mirror green)', () => {
    const r = evaluateRequiredContexts({ ...base, commitStatuses: [{ context: LOCAL_VERIFY_CONTEXT, state: 'success' }] });
    expect(r).toEqual({ ok: true, problems: [] });
  });

  it('refuses when the status is pending, failure, or absent', () => {
    for (const commitStatuses of [[{ context: LOCAL_VERIFY_CONTEXT, state: 'pending' }], [{ context: LOCAL_VERIFY_CONTEXT, state: 'failure' }], []]) {
      const r = evaluateRequiredContexts({ ...base, commitStatuses });
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toMatch(/instar\/local-verify/);
    }
  });

  it('a check RUN named instar/local-verify does not satisfy it', () => {
    const r = evaluateRequiredContexts({ ...base, checkRuns: [...allGreenRuns, { name: LOCAL_VERIFY_CONTEXT, conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' }] });
    expect(r.ok).toBe(false);
  });

  it('a success status for a different context does not satisfy it', () => {
    const r = evaluateRequiredContexts({ ...base, commitStatuses: [{ context: 'ci/other', state: 'success' }] });
    expect(r.ok).toBe(false);
  });

  it('when local-verify is not required, statuses are irrelevant (behaviour unchanged)', () => {
    const r = evaluateRequiredContexts({ ...base, rulesetContexts: [] });
    expect(r.ok).toBe(true);
  });
});

describe('fetchProtectionContexts — reads /branches/<b>; a /protection 404 no longer means "none"', () => {
  const BRANCH = {
    name: 'main', protected: true,
    protection: { required_status_checks: {
      enforcement_level: 'non_admins',
      contexts: ['Type Check', 'Build'],
      checks: [{ context: 'Type Check', app_id: 15368 }, { context: 'Unit Tests (node 20, shard 1/4)', app_id: 15368 }],
    } },
  };
  const fakeGh = (responses) => (args) => {
    const path = args[1];
    const hit = Object.entries(responses).find(([k]) => path.endsWith(k));
    if (!hit) throw new Error(`unexpected gh call ${path}`);
    return hit[1];
  };
  const ok = (data) => ({ status: 0, stdout: JSON.stringify(data), stderr: '' });
  const notFound = { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };

  it('non-admin: /protection 404 → contexts from /branches (contexts ∪ checks[].context), reviewsRequired false', () => {
    const r = fetchProtectionContexts('JKHeadley/instar', 'main', fakeGh({ '/branches/main': ok(BRANCH), '/protection': notFound }));
    expect(r.contexts.sort()).toEqual(['Build', 'Type Check', 'Unit Tests (node 20, shard 1/4)']);
    expect(r.reviewsRequired).toBe(false);
  });

  it('admin: a readable /protection supplies the classic reviews flag and its contexts are unioned', () => {
    const r = fetchProtectionContexts('JKHeadley/instar', 'main', fakeGh({
      '/branches/main': ok(BRANCH),
      '/protection': ok({ required_status_checks: { contexts: ['E2E Tests'] }, required_pull_request_reviews: { required_approving_review_count: 1 } }),
    }));
    expect(r.contexts).toContain('E2E Tests');
    expect(r.contexts).toContain('Build');
    expect(r.reviewsRequired).toBe(true);
  });

  it('an unprotected branch contributes nothing', () => {
    const r = fetchProtectionContexts('o/r', 'dev', fakeGh({ '/branches/dev': ok({ name: 'dev', protected: false }), '/protection': notFound }));
    expect(r).toEqual({ contexts: [], reviewsRequired: false });
  });

  it('a /branches failure is unverifiable (throws → refused:contexts-unverifiable), never "none"', () => {
    expect(() => fetchProtectionContexts('o/r', 'main', fakeGh({ '/branches/main': notFound, '/protection': notFound }))).toThrow(/unverifiable/);
  });

  it('a non-404 /protection failure is unverifiable', () => {
    expect(() => fetchProtectionContexts('o/r', 'main', fakeGh({ '/branches/main': ok(BRANCH), '/protection': { status: 1, stdout: '', stderr: 'HTTP 502' } }))).toThrow(/unverifiable/);
  });

  it('extractBranchProtection: review requirements come only from the ruleset when /protection is unreadable', () => {
    expect(extractBranchProtection(BRANCH, null).reviewsRequired).toBe(false);
    expect(extractRulesetReviewPolicy([{ type: 'pull_request', parameters: { required_approving_review_count: 0, require_last_push_approval: true } }]))
      .toEqual({ reviewsRequired: false, lastPushApprovalRequired: true });
  });
});

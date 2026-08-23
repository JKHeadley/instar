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

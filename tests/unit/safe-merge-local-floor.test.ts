/**
 * safe-merge's `local` floor (docs/specs/local-verify-merge-authority.md §3):
 * floor selection, the §3 predicate on both sides of every rule, the independent
 * review a flagged record needs (directive 2026-10-22), the merge-time body checks, and the config
 * read (port + token from the agent's config file only).
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateLocalPredicate,
  hasIndependentReview,
  selectSafeMergeFloor,
  parseAgentServerConfig,
  runLocalBodyChecks,
  decisionRecordPaths,
  resolveAgentHome,
  capabilities,
  UNMEASURABLE,
  LOCAL_FLOOR_BODY_CHECKS,
  verifyRequestOutcome,
} from '../../scripts/safe-merge.mjs';
import { selectMergeFloor, isMergeEligible, approvedAtHead, MERGE_FLOOR_MODES, reviewPrecheckPasses } from '../../scripts/local-verify-floor.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const REPO = 'JKHeadley/instar';

const record = (over: Record<string, unknown> = {}) => ({
  repo: REPO, pr: 42, headSha: HEAD, baseSha: BASE, baseRefName: 'main', outcome: 'success',
  lanes: [
    { name: 'unit', gating: true, files: 10, tests: 100, failed: 0, seconds: 60 },
    { name: 'e2e', gating: true, files: 2, tests: 5, failed: 0, seconds: 30 },
  ],
  harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
  ...over,
});
const okChecks = LOCAL_FLOOR_BODY_CHECKS.map((name: string) => ({ name, ok: true }));
const base = () => ({
  repo: REPO, pr: 42, livePr: { headRefOid: HEAD, baseRefName: 'main' }, record: record(),
  mainHealth: { state: 'healthy', mainHead: MAIN }, bodyChecks: okChecks,
});
const TRACE = '.instar/instar-dev-traces/2026-10-22-x.json';

describe('evaluateLocalPredicate — the §3 predicate, both sides of every rule', () => {
  it('admits a green record for the current head and base', () => {
    expect(evaluateLocalPredicate(base())).toEqual({ ok: true });
  });

  it.each(['harnessChanging', 'protectedPath', 'skipsAdded', 'testsRemoved'])('a %s flag that is missing or not a boolean is unmeasurable, never unflagged', (k) => {
    const missing = record(); delete (missing as Record<string, unknown>)[k];
    expect(evaluateLocalPredicate({ ...base(), record: missing }).result).toBe(UNMEASURABLE);
    expect(evaluateLocalPredicate({ ...base(), record: record({ [k]: 'false' } as never) }).result).toBe(UNMEASURABLE);
  });

  it('an absent record is unmeasurable (never an Actions fallback)', () => {
    expect(evaluateLocalPredicate({ ...base(), record: null }).result).toBe(UNMEASURABLE);
  });

  it.each([
    ['repo', { record: record({ repo: 'other/repo' }) }],
    ['pr', { record: record({ pr: 43 }) }],
    ['head', { livePr: { headRefOid: 'd'.repeat(40), baseRefName: 'main' } }],
    ['base branch', { livePr: { headRefOid: HEAD, baseRefName: 'release' } }],
  ])('refuses a %s mismatch against the fresh GitHub read', (_n, over) => {
    expect(evaluateLocalPredicate({ ...base(), ...over }).result).toBe('refused:verify-record-mismatch');
  });

  it('refuses a failed or errored run', () => {
    expect(evaluateLocalPredicate({ ...base(), record: record({ outcome: 'failure' }) }).result).toBe('refused:verify-failed');
    expect(evaluateLocalPredicate({ ...base(), record: record({ outcome: 'error' }) }).result).toBe('refused:verify-failed');
  });

  it('refuses a gating lane with a failure, zero tests, or zero files; ignores non-gating lanes', () => {
    for (const lane of [{ failed: 1 }, { tests: 0 }, { files: 0 }]) {
      const lanes = [{ name: 'unit', gating: true, files: 10, tests: 100, failed: 0, seconds: 1, ...lane }];
      expect(evaluateLocalPredicate({ ...base(), record: record({ lanes }) }).result).toBe('refused:verify-lanes');
    }
    const lanes = [...record().lanes, { name: 'advisory', gating: false, files: 0, tests: 0, failed: 3, seconds: 1 }];
    expect(evaluateLocalPredicate({ ...base(), record: record({ lanes }) }).ok).toBe(true);
  });

  it('refuses a record with no gating lane at all (vacuous truth is not a pass)', () => {
    expect(evaluateLocalPredicate({ ...base(), record: record({ lanes: [] }) }).result).toBe('refused:verify-lanes');
  });

  it('while main is unhealthy, admits only a record verified against the current main head', () => {
    for (const state of ['main-suspect', 'main-red']) {
      const stale = evaluateLocalPredicate({ ...base(), mainHealth: { state, mainHead: MAIN } });
      expect(stale.result).toBe('refused:main-red');
      const repair = evaluateLocalPredicate({ ...base(), record: record({ baseSha: MAIN }), mainHealth: { state, mainHead: MAIN } });
      expect(repair.ok).toBe(true);
    }
  });

  it('an unreadable main health is unmeasurable', () => {
    expect(evaluateLocalPredicate({ ...base(), mainHealth: null }).result).toBe(UNMEASURABLE);
    expect(evaluateLocalPredicate({ ...base(), mainHealth: { state: 'weird', mainHead: MAIN } }).result).toBe(UNMEASURABLE);
  });

  it('refuses when a merge-time body check fails, and when none ran', () => {
    const failing = okChecks.map((c: { name: string }) => (c.name === 'eli16' ? { ...c, ok: false, detail: 'no-eli16-heading' } : c));
    const r = evaluateLocalPredicate({ ...base(), bodyChecks: failing });
    expect(r.result).toBe('refused:body-checks');
    expect(r.problems.join(' ')).toMatch(/eli16/);
    expect(evaluateLocalPredicate({ ...base(), bodyChecks: [] }).result).toBe(UNMEASURABLE);
  });

  it.each(['harnessChanging', 'protectedPath', 'skipsAdded', 'testsRemoved'])(
    'a %s record needs the recorded independent review of this head — never the operator',
    (flag) => {
      const flagged = { ...base(), record: record({ [flag]: true }) };
      const r = evaluateLocalPredicate(flagged);
      expect(r.result).toBe('refused:needs-independent-review');
      expect(r.problems.join(' ')).toMatch(/second pass concurred/);
      expect(evaluateLocalPredicate({ ...base(), record: record({ [flag]: true, independentReview: { trace: TRACE, concurred: true } }) }).ok).toBe(true);
      // An operator approval is no longer an input: passing one admits nothing.
      expect(evaluateLocalPredicate({ ...flagged, operatorApprovedHead: true, approverAcceptance: { matches: true } } as never).result).toBe('refused:needs-independent-review');
    },
  );

  it('a malformed independent review is not one', () => {
    for (const bad of [{ trace: TRACE, concurred: false }, { trace: 'docs/x.json', concurred: true }, { concurred: true }, 'yes', null]) {
      expect(evaluateLocalPredicate({ ...base(), record: record({ protectedPath: true, independentReview: bad }) }).result).toBe('refused:needs-independent-review');
      expect(hasIndependentReview({ independentReview: bad })).toBe(false);
    }
    expect(hasIndependentReview({ independentReview: { trace: TRACE, concurred: true } })).toBe(true);
  });

  it('an ordinary record never needs an independent review', () => {
    expect(evaluateLocalPredicate(base()).ok).toBe(true);
  });
});

describe('selectSafeMergeFloor — one floor function, never a silent Actions fallback', () => {
  const agent = { port: 4042, tokenSource: 'inline', inlineToken: 't', floor: 'local', repo: REPO, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley' };
  const view = { author: { login: 'EchoOfDawn' }, isCrossRepository: false };
  const server = (status: number, body: unknown) => async () => ({ status, body });
  const localStatus = { floor: { configured: 'local', effective: 'local', reason: 'ok' }, mainHealth: { state: 'healthy', mainHead: MAIN } };

  it('selects local for an eligible PR of the configured repo when the server says effective local', async () => {
    const r = await selectSafeMergeFloor({ repo: REPO, view, agent, override: undefined, serverGet: server(200, localStatus) });
    expect(r).toMatchObject({ floor: 'local', status: localStatus });
    expect(r.refusal).toBeUndefined();
  });

  it('INSTAR_MERGE_FLOOR=actions forces actions; it can never force local', async () => {
    expect((await selectSafeMergeFloor({ repo: REPO, view, agent, override: 'actions', serverGet: server(200, localStatus) })).floor).toBe('actions');
    const actionsAgent = { ...agent, floor: 'actions' };
    expect((await selectSafeMergeFloor({ repo: REPO, view, agent: actionsAgent, override: 'local', serverGet: server(200, localStatus) })).floor).toBe('actions');
  });

  it('stays on actions with no agent config, a config floor of actions, another repo, or an ineligible PR', async () => {
    const sg = server(200, localStatus);
    expect((await selectSafeMergeFloor({ repo: REPO, view, agent: null, serverGet: sg })).floor).toBe('actions');
    expect((await selectSafeMergeFloor({ repo: REPO, view, agent: { ...agent, floor: 'actions' }, serverGet: sg })).floor).toBe('actions');
    expect((await selectSafeMergeFloor({ repo: 'other/repo', view, agent, serverGet: sg })).floor).toBe('actions');
    expect((await selectSafeMergeFloor({ repo: REPO, view: { ...view, author: { login: 'stranger' } }, agent, serverGet: sg })).floor).toBe('actions');
    expect((await selectSafeMergeFloor({ repo: REPO, view: { ...view, isCrossRepository: true }, agent, serverGet: sg })).floor).toBe('actions');
  });

  it('the operator login is eligible too', async () => {
    const r = await selectSafeMergeFloor({ repo: REPO, view: { ...view, author: { login: 'JKHeadley' } }, agent, serverGet: server(200, localStatus) });
    expect(r.floor).toBe('local');
  });

  it('server down, a non-200, or an unreadable floor is unmeasurable', async () => {
    const down = async () => { throw new Error('ECONNREFUSED'); };
    for (const sg of [down, server(503, {}), server(200, { floor: {} })]) {
      const r = await selectSafeMergeFloor({ repo: REPO, view, agent, serverGet: sg });
      expect(r.floor).toBe('local');
      expect(r.refusal.result).toBe(UNMEASURABLE);
    }
  });

  it('the server effective floor of actions (e.g. a live rollback) is honoured', async () => {
    const r = await selectSafeMergeFloor({ repo: REPO, view, agent, serverGet: server(200, { ...localStatus, floor: { configured: 'local', effective: 'actions', reason: 'rollback' } }) });
    expect(r.floor).toBe('actions');
  });
});

describe('shared floor module (scripts/local-verify-floor.mjs)', () => {
  it('approvedAtHead skips a review whose submittedAt does not parse', () => {
    const head = 'a'.repeat(40);
    const reviews = [
      { login: 'JKHeadley', state: 'APPROVED', commitId: head, submittedAt: '2026-10-21T10:00:00Z' },
      { login: 'JKHeadley', state: 'CHANGES_REQUESTED', commitId: head, submittedAt: 'not-a-date' },
    ];
    expect(approvedAtHead(reviews, 'JKHeadley', head).approved).toBe(true);
    expect(approvedAtHead([{ login: 'JKHeadley', state: 'APPROVED', commitId: head }], 'JKHeadley', head).approved).toBe(false);
  });

  it('selectMergeFloor needs every condition', () => {
    const ok = { effectiveFloor: 'local', configRepo: REPO, repo: REPO, eligible: true };
    expect(selectMergeFloor(ok)).toBe('local');
    expect(selectMergeFloor({ ...ok, effectiveFloor: 'actions' })).toBe('actions');
    expect(selectMergeFloor({ ...ok, repo: 'x/y' })).toBe('actions');
    expect(selectMergeFloor({ ...ok, eligible: false })).toBe('actions');
    expect(selectMergeFloor({ ...ok, override: 'actions' })).toBe('actions');
    expect(MERGE_FLOOR_MODES).toEqual(['actions', 'local']);
  });

  it('isMergeEligible: agent or operator login, never a fork', () => {
    const logins = { expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley' };
    expect(isMergeEligible({ author: { login: 'EchoOfDawn' }, isCrossRepository: false }, logins)).toBe(true);
    expect(isMergeEligible({ author: { login: 'JKHeadley' }, isCrossRepository: false }, logins)).toBe(true);
    expect(isMergeEligible({ author: { login: 'EchoOfDawn' }, isCrossRepository: true }, logins)).toBe(false);
    expect(isMergeEligible({ author: { login: 'EchoOfDawn' } }, logins)).toBe(false);
    expect(isMergeEligible({ author: { login: '' }, isCrossRepository: false }, { expectedGhLogin: '', operatorGhLogin: '' })).toBe(false);
  });

  it('approvedAtHead: older head, non-operator, and a later CHANGES_REQUESTED all refuse', () => {
    const r = (login: string, state: string, commitId: string, t: string) => ({ login, state, commitId, submittedAt: t });
    expect(approvedAtHead([r('JKHeadley', 'APPROVED', HEAD, '2026-10-01T00:00:00Z')], 'JKHeadley', HEAD).approved).toBe(true);
    expect(approvedAtHead([r('JKHeadley', 'APPROVED', BASE, '2026-10-01T00:00:00Z')], 'JKHeadley', HEAD).approved).toBe(false);
    expect(approvedAtHead([r('someone', 'APPROVED', HEAD, '2026-10-01T00:00:00Z')], 'JKHeadley', HEAD).approved).toBe(false);
    expect(approvedAtHead([
      r('JKHeadley', 'APPROVED', HEAD, '2026-10-01T00:00:00Z'),
      r('JKHeadley', 'CHANGES_REQUESTED', HEAD, '2026-10-02T00:00:00Z'),
      r('JKHeadley', 'COMMENTED', HEAD, '2026-10-03T00:00:00Z'),
    ], 'JKHeadley', HEAD).approved).toBe(false);
  });
});

describe('parseAgentServerConfig — port and token from the config file only', () => {
  it('reads port, inline token, floor, repo and logins (with defaults)', () => {
    const c = parseAgentServerConfig(JSON.stringify({ port: 4042, authToken: 'tok', monitoring: { greenPrAutoMerge: { floor: 'local', expectedGhLogin: 'EchoOfDawn' } } }));
    expect(c).toMatchObject({ port: 4042, tokenSource: 'inline', inlineToken: 'tok', floor: 'local', repo: REPO, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley' });
  });

  it('marks a vault-backed token for lazy resolution and never treats it as a value', () => {
    const c = parseAgentServerConfig(JSON.stringify({ port: 4042, authToken: { secret: true } }));
    expect(c).toMatchObject({ tokenSource: 'vault', inlineToken: null, floor: 'actions' });
  });

  it('anything but floor:"local" is actions; a bad port is null; unparseable JSON throws', () => {
    expect(parseAgentServerConfig(JSON.stringify({ port: 'x', monitoring: { greenPrAutoMerge: { floor: 'LOCAL' } } }))).toMatchObject({ port: null, floor: 'actions' });
    expect(() => parseAgentServerConfig('{nope')).toThrow();
  });

  it('resolveAgentHome: a worktree resolves to the agent home that owns the git common dir', () => {
    const run = () => ({ status: 0, stdout: '/Users/x/.instar/agents/echo/.git\n' });
    expect(resolveAgentHome('/Users/x/.instar/agents/echo/.worktrees/w/scripts', run as never)).toBe('/Users/x/.instar/agents/echo');
    const fail = () => ({ status: 128, stdout: '' });
    expect(resolveAgentHome('/somewhere/repo/scripts', fail as never)).toBe('/somewhere/repo');
  });

  it('resolveAgentHome runs git with every GIT_* variable removed (an inherited GIT_DIR cannot redirect it)', () => {
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
    process.env.GIT_DIR = '/elsewhere/.git';
    process.env.GIT_COMMON_DIR = '/elsewhere/.git';
    try {
      let seen: NodeJS.ProcessEnv | undefined;
      const run = (_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => { seen = o.env; return { status: 0, stdout: '/Users/x/.instar/agents/echo/.git\n' }; };
      resolveAgentHome('/Users/x/.instar/agents/echo/scripts', run as never);
      expect(seen).toBeDefined();
      expect(Object.keys(seen!).filter((k) => k.startsWith('GIT_'))).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe('runLocalBodyChecks — eli16, decision-audit, release-fragment from the trusted copy', () => {
  const eli16Body = `## Summary\nx\n\n## ELI16\n${'This explains the change in plain words for a reader. '.repeat(6)}\n`;
  const pr = { title: 'fix: thing', body: eli16Body, authorLogin: 'EchoOfDawn', authorType: 'User' };

  it('passes a docs-only PR with an ELI16 section', () => {
    const r = runLocalBodyChecks({ ...pr, files: [{ filename: 'docs/a.md', status: 'modified' }], decisionRecords: [] });
    expect(r.map((c: { name: string }) => c.name)).toEqual(['eli16', 'decision-audit', 'release-fragment']);
    expect(r.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('fails eli16 without the section', () => {
    const r = runLocalBodyChecks({ ...pr, body: 'short', files: [], decisionRecords: [] });
    expect(r.find((c: { name: string }) => c.name === 'eli16').ok).toBe(false);
  });

  it('fails decision-audit and release-fragment for an src change with neither a record nor a fragment', () => {
    const r = runLocalBodyChecks({ ...pr, files: [{ filename: 'src/x.ts', status: 'modified' }], decisionRecords: [] });
    expect(r.find((c: { name: string }) => c.name === 'decision-audit').ok).toBe(false);
    expect(r.find((c: { name: string }) => c.name === 'release-fragment').ok).toBe(false);
  });

  it('passes an src change carrying a covering decision record and a fragment', () => {
    const files = [
      { filename: 'src/x.ts', status: 'modified' },
      { filename: '.instar/instar-dev-decisions/1-x.json', status: 'added' },
      { filename: 'upgrades/next/x.md', status: 'added' },
    ];
    expect(decisionRecordPaths(files)).toEqual(['.instar/instar-dev-decisions/1-x.json']);
    const r = runLocalBodyChecks({ ...pr, files, decisionRecords: [{ scope: { files: ['src/x.ts'] } }] });
    expect(r.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });
});

describe('capabilities — floorModes', () => {
  it('reports both floor modes and the local-floor feature', () => {
    const c = capabilities();
    expect(c.floorModes).toEqual(['actions', 'local']);
    expect(c.features).toContain('local-floor');
  });
});

describe('verifyRequestOutcome — the POST /local-verify outcome for verify-pending', () => {
  it('reads the service status or refusal code; anything else is unreadable', () => {
    expect(verifyRequestOutcome({ status: 202, body: { ok: true, status: 'queued' } })).toBe('queued');
    expect(verifyRequestOutcome({ status: 429, body: { ok: false, code: 'queue-full' } })).toBe('queue-full');
    expect(verifyRequestOutcome({ status: 500, body: { error: 'x' } })).toBeNull();
    expect(verifyRequestOutcome(null)).toBeNull();
  });
  it('a held answer (main-red hold, CMT-1033) carries the plain hold reason so the session sees which check and which PR is fixing it', () => {
    const detail = 'main is red on tests/unit/no-silent-fallbacks.test.ts; PR #2372 is already fixing it. A PR that does not touch or name that file would fail the same check, so it waits until main is green.';
    expect(verifyRequestOutcome({ status: 202, body: { ok: true, status: 'queued', hold: { reason: 'main-red', detail } } })).toBe(`queued (held: ${detail})`);
    expect(verifyRequestOutcome({ status: 202, body: { ok: true, status: 'queued', hold: 'x' } })).toBe('queued');
  });
});

describe('reviewPrecheckPasses — the shared review precheck', () => {
  it('passes when no review is required, or when approved; fails when required and not approved', () => {
    const none = { reviewsRequired: false, lastPushApprovalRequired: false };
    expect(reviewPrecheckPasses({ policy: none, reviewDecision: null })).toBe(true);
    expect(reviewPrecheckPasses({ policy: { ...none, lastPushApprovalRequired: true }, reviewDecision: 'REVIEW_REQUIRED' })).toBe(false);
    expect(reviewPrecheckPasses({ policy: { ...none, reviewsRequired: true }, reviewDecision: 'APPROVED' })).toBe(true);
    expect(reviewPrecheckPasses({ classicReviewsRequired: true, reviewDecision: '' })).toBe(false);
  });

  it('require_code_owner_review holds only a PR that touches a code-owned path, until APPROVED', () => {
    const co = { reviewsRequired: false, lastPushApprovalRequired: false, codeOwnerReviewRequired: true };
    expect(reviewPrecheckPasses({ policy: co, reviewDecision: 'REVIEW_REQUIRED', codeOwnedTouched: true })).toBe(false);
    expect(reviewPrecheckPasses({ policy: co, reviewDecision: 'APPROVED', codeOwnedTouched: true })).toBe(true);
    expect(reviewPrecheckPasses({ policy: co, reviewDecision: 'REVIEW_REQUIRED', codeOwnedTouched: false })).toBe(true);
    expect(reviewPrecheckPasses({ policy: co, reviewDecision: '' })).toBe(true); // ownership not known here: GitHub's rule is consulted by safe-merge
  });
});

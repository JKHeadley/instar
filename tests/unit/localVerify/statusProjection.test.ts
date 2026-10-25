/**
 * Tier-1 tests for the `instar/local-verify` status projection (spec
 * local-verify-merge-authority.md §3 "What success requires, in full", the
 * Actions-floor mirror, shared heads). Both sides of every condition.
 * The mirror uses safe-merge's REAL evaluateRequiredContexts.
 */

import { describe, expect, it } from 'vitest';
import { evaluateRequiredContexts, ACTIONS_FLOOR_CONTEXTS, LOCAL_VERIFY_CONTEXT } from '../../../scripts/safe-merge.mjs';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import {
  LOCAL_VERIFY_STATUS_CONTEXT, projectHead, projectLocal, projectMirror, projectPr,
  type CheckRunView, type ContextPin, type EvaluateRequiredContexts, type MirrorInput, type ProjectionInput,
} from '../../../src/localVerify/statusProjection.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const evaluate = evaluateRequiredContexts as EvaluateRequiredContexts;
const FLOOR = ACTIONS_FLOOR_CONTEXTS as ContextPin[];

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 7, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [
      { name: 'unit', gating: true, files: 10, tests: 300, passed: 300, failed: 0, skipped: 0, todo: 0, seconds: 60 },
      { name: 'e2e', gating: true, files: 5, tests: 40, passed: 40, failed: 0, skipped: 0, todo: 0, seconds: 600 },
    ],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}

function input(over: Partial<ProjectionInput> = {}, prOver: Partial<ProjectionInput['pr']> = {}): ProjectionInput {
  return {
    pr: { number: 7, headSha: sha('a'), baseRefName: 'main', eligible: true, floor: 'local', ...prOver },
    repo: REPO,
    record: record(),
    verifying: false,
    mainHealth: { state: 'healthy', mainHeadSha: sha('b') },
    ...over,
  };
}

function greenRuns(): CheckRunView[] {
  return FLOOR.map((f) => ({ name: f.context, status: 'completed', conclusion: 'success', appSlug: f.appSlug ?? null, workflowPath: f.workflowPath ?? null }));
}

function mirror(over: Partial<MirrorInput> = {}): MirrorInput {
  return { floor: FLOOR, protectionContexts: [], rulesetContexts: [], checkRuns: greenRuns(), evaluate, ...over };
}

describe('projectLocal — what success requires, in full', () => {
  it('a green record for this (repo, pr, head, base), main healthy ⇒ success with the record description', () => {
    const p = projectLocal(input());
    expect(p.state).toBe('success');
    expect(p.description.startsWith('verified')).toBe(true);
    expect(p.description.length).toBeLessThanOrEqual(140);
  });

  it('no record ⇒ pending (awaiting-verify), or verifying while queued/running', () => {
    expect(projectLocal(input({ record: null }))).toMatchObject({ state: 'pending', reason: 'awaiting-verify' });
    expect(projectLocal(input({ record: null, verifying: true }))).toMatchObject({ state: 'pending', reason: 'verifying' });
  });

  it('a record for another head, PR, base, or repo never authorizes', () => {
    for (const r of [record({ headSha: sha('c') }), record({ pr: 8 }), record({ baseRefName: 'release' }), record({ repo: 'evil/repo' })]) {
      expect(projectLocal(input({ record: r })).state).toBe('pending');
    }
  });

  it('a PR not targeting main is never success', () => {
    expect(projectLocal(input({ record: record({ baseRefName: 'dev' }) }, { baseRefName: 'dev' }))).toMatchObject({ state: 'pending', reason: 'base-not-main' });
  });

  it('failure ⇒ failure; error ⇒ failure; but either is pending while a re-run is queued', () => {
    expect(projectLocal(input({ record: record({ outcome: 'failure' }) }))).toMatchObject({ state: 'failure', reason: 'verify-failed' });
    expect(projectLocal(input({ record: record({ outcome: 'error', errorStep: 'npm-ci', mergeTree: '' }) }))).toMatchObject({ state: 'failure', reason: 'verify-error' });
    expect(projectLocal(input({ record: record({ outcome: 'failure' }), verifying: true })).state).toBe('pending');
  });

  it('every gating lane needs failed == 0, tests > 0, files > 0 (non-gating lanes do not count)', () => {
    const lane = (o: object) => ({ name: 'unit', gating: true, files: 1, tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, seconds: 1, ...o });
    expect(projectLocal(input({ record: record({ lanes: [lane({ tests: 0 })] }) })).reason).toBe('lane-counts');
    expect(projectLocal(input({ record: record({ lanes: [lane({ files: 0 })] }) })).reason).toBe('lane-counts');
    expect(projectLocal(input({ record: record({ lanes: [lane({ failed: 1 })] }) })).reason).toBe('lane-counts');
    expect(projectLocal(input({ record: record({ lanes: [] }) })).reason).toBe('lane-counts');
    expect(projectLocal(input({ record: record({ lanes: [lane({}), lane({ gating: false, tests: 0, files: 0 })] }) })).state).toBe('success');
  });

  for (const flag of ['harnessChanging', 'protectedPath', 'skipsAdded', 'testsRemoved'] as const) {
    it(`${flag} needs the verifier-recorded independent review — operator approval is not an input`, () => {
      const r = record({ [flag]: true });
      expect(projectLocal(input({ record: r }))).toMatchObject({ state: 'pending', reason: 'awaiting-independent-review' });
      expect(projectLocal(input({ record: r })).description).toMatch(/^awaiting-independent-review · /);
      expect(projectLocal(input({ record: record({ [flag]: true, independentReview: { trace: '.instar/instar-dev-traces/t.json', concurred: true } }) })).state).toBe('success');
    });
  }

  it('an ordinary PR needs no independent review', () => {
    expect(projectLocal(input({})).state).toBe('success');
  });

  for (const state of ['main-suspect', 'main-red'] as const) {
    it(`${state}: only a record verified against the CURRENT main head is admitted (the repair)`, () => {
      expect(projectLocal(input({ mainHealth: { state, mainHeadSha: sha('c') } }))).toMatchObject({ state: 'pending', reason: state });
      expect(projectLocal(input({ mainHealth: { state, mainHeadSha: sha('b') } })).state).toBe('success');
      expect(projectLocal(input({ mainHealth: { state, mainHeadSha: null } })).state).toBe('pending');
    });
  }
});

describe('projectMirror — the Actions-floor mirror', () => {
  it('posts the same context name safe-merge reads', () => {
    expect(LOCAL_VERIFY_STATUS_CONTEXT).toBe(LOCAL_VERIFY_CONTEXT);
  });

  it('every Actions-floor context green with the right producer ⇒ success', () => {
    expect(projectMirror(mirror())).toMatchObject({ state: 'success' });
  });

  it('excludes instar/local-verify itself everywhere, or the mirror could never bootstrap', () => {
    const m = mirror({
      floor: [...FLOOR, { context: LOCAL_VERIFY_STATUS_CONTEXT }],
      rulesetContexts: [LOCAL_VERIFY_STATUS_CONTEXT],
      protectionContexts: [LOCAL_VERIFY_STATUS_CONTEXT],
    });
    expect(projectMirror(m).state).toBe('success');
  });

  it('a pinned classic context (unit shard) in the input list is required too', () => {
    const shard = { context: 'Unit Tests (shard 1/4)', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions' };
    expect(projectMirror(mirror({ floor: [...FLOOR, shard] })).state).toBe('pending'); // not started
    const runs = [...greenRuns(), { name: shard.context, status: 'completed', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' }];
    expect(projectMirror(mirror({ floor: [...FLOOR, shard], checkRuns: runs })).state).toBe('success');
  });

  it('a running context ⇒ pending; a missing one ⇒ pending', () => {
    const running = greenRuns().map((r) => (r.name === 'E2E Tests' ? { ...r, status: 'in_progress', conclusion: null } : r));
    expect(projectMirror(mirror({ checkRuns: running }))).toMatchObject({ state: 'pending', reason: 'actions-floor-running' });
    expect(projectMirror(mirror({ checkRuns: greenRuns().filter((r) => r.name !== 'Build') })).state).toBe('pending');
  });

  it('a failed context with nothing still running for it ⇒ failure', () => {
    const failed = greenRuns().map((r) => (r.name === 'Type Check' ? { ...r, conclusion: 'failure' } : r));
    expect(projectMirror(mirror({ checkRuns: failed }))).toMatchObject({ state: 'failure', reason: 'actions-floor-failed' });
    const skipped = greenRuns().map((r) => (r.name === 'eli16' ? { ...r, conclusion: 'skipped' } : r));
    expect(projectMirror(mirror({ checkRuns: skipped })).state).toBe('failure');
  });

  it('a success from the wrong producer ⇒ failure (the same pin safe-merge enforces)', () => {
    const wrong = greenRuns().map((r) => (r.name === 'Build' ? { ...r, workflowPath: '.github/workflows/evil.yml' } : r));
    expect(projectMirror(mirror({ checkRuns: wrong }))).toMatchObject({ state: 'failure', reason: 'actions-floor-producer' });
  });

  it('unreadable check runs ⇒ pending, never success', () => {
    expect(projectMirror(mirror({ checkRuns: null }))).toMatchObject({ state: 'pending', reason: 'checks-unreadable' });
  });

  it('uses the evaluation function it is given (no second implementation)', () => {
    let called = 0;
    const fake: EvaluateRequiredContexts = () => { called++; return { ok: true, problems: [] }; };
    expect(projectMirror(mirror({ evaluate: fake, checkRuns: [] })).state).toBe('success');
    expect(called).toBe(1);
  });

  it('projectPr: actions floor or ineligible ⇒ mirror; local + eligible ⇒ local authorization', () => {
    expect(projectPr(input({ record: null, mirror: mirror() }, { floor: 'actions' })).state).toBe('success');
    expect(projectPr(input({ record: null, mirror: mirror() }, { eligible: false })).state).toBe('success');
    expect(projectPr(input({ record: null, mirror: mirror() })).state).toBe('pending');
    expect(projectPr(input({ record: null }, { floor: 'actions' }))).toMatchObject({ state: 'pending', reason: 'mirror-unavailable' });
  });
});

describe('projectHead — shared heads', () => {
  it('success only when every open PR to main with that head is authorized', () => {
    const a = input();
    const b = input({ record: record({ pr: 8 }) }, { number: 8 });
    expect(projectHead([a, b]).state).toBe('success');
    const bUnverified = input({ record: null }, { number: 8 });
    const h = projectHead([a, bUnverified]);
    expect(h.state).toBe('pending');
    expect(h.reason).toBe('shared-head:awaiting-verify');
    expect(h.description).toContain('#8');
    expect(h.prs).toEqual([{ pr: 7, state: 'success', reason: 'authorized' }, { pr: 8, state: 'pending', reason: 'awaiting-verify' }]);
  });

  it('any failing PR on the head ⇒ failure', () => {
    const a = input();
    const b = input({ record: record({ pr: 8, outcome: 'failure' }) }, { number: 8 });
    expect(projectHead([a, b]).state).toBe('failure');
  });

  it('PRs to other bases are ignored; no PR to main ⇒ pending', () => {
    const a = input();
    const other = input({ record: null }, { number: 9, baseRefName: 'release' });
    expect(projectHead([a, other]).state).toBe('success');
    expect(projectHead([other]).state).toBe('pending');
  });
});

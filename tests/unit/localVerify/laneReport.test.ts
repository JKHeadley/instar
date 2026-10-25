/**
 * Tier-1 tests for vitest JSON parsing and the local-verify run predicate
 * (spec local-verify-merge-authority.md §2 step 5). The fixture shape is the
 * one vitest 2.1.9's JsonReporter emits (absolute `name`, file `status`,
 * `assertionResults[].status`).
 */

import { describe, it, expect } from 'vitest';
import { parseVitestJson, evaluateRun, LaneReportParseError, FAILURE_MESSAGE_MAX, type LaneRunInput } from '../../../src/localVerify/laneReport.js';
import { computeInventory, LANES, type LaneDefinition } from '../../../src/localVerify/inventory.js';

const ROOT = '/Users/x/.instar/agents/echo/.worktrees/.verify/runs/abcdef012345';

type A = { status: string };
function file(rel: string, statuses: string[], fileStatus?: 'passed' | 'failed', message = '') {
  const assertionResults: A[] = statuses.map((s) => ({ status: s }));
  return {
    assertionResults: assertionResults.map((a, i) => ({
      ancestorTitles: ['suite'], fullName: `suite t${i}`, status: a.status, title: `t${i}`,
      duration: 1, failureMessages: a.status === 'failed' ? ['boom'] : [], location: null, meta: {},
    })),
    startTime: 1, endTime: 2,
    status: fileStatus ?? (statuses.includes('failed') ? 'failed' : 'passed'),
    message, name: `${ROOT}/${rel}`,
  };
}
function report(files: ReturnType<typeof file>[]): string {
  return JSON.stringify({
    numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
    numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    snapshot: {}, startTime: 0, success: true, testResults: files,
  });
}

describe('parseVitestJson', () => {
  it('counts per file and relativises the absolute name', () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', ['passed', 'passed', 'skipped', 'todo', 'disabled'])]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')).toEqual({ passed: 2, failed: 0, skipped: 2, todo: 1, message: '' });
  });
  it('failed and pending (unfinished or .only) assertions count as failures', () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', ['failed', 'pending', 'passed'])]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')!.failed).toBe(2);
  });
  it('a file-level failure with no failed assertion (import error) counts one failure', () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', [], 'failed', 'Cannot find module')]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')).toMatchObject({ failed: 1, message: 'Cannot find module' });
  });
  it('a file-level failure with failed assertions is not double counted', () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', ['failed'])]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')!.failed).toBe(1);
  });
  it("keeps the first failing test's title and message, bounded", () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', ['passed', 'failed', 'failed'])]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')!.message).toBe('t1: boom');
    const long = file('tests/unit/b.test.ts', ['failed']);
    long.assertionResults[0].failureMessages = ['x'.repeat(5000)];
    expect(parseVitestJson(report([long]), ROOT).files.get('tests/unit/b.test.ts')!.message!.length).toBe(FAILURE_MESSAGE_MAX);
  });
  it('rejects non-JSON and the wrong shape', () => {
    expect(() => parseVitestJson('not json', ROOT)).toThrow(LaneReportParseError);
    expect(() => parseVitestJson('{"foo":1}', ROOT)).toThrow(LaneReportParseError);
    expect(() => parseVitestJson('{"testResults":[{"name":1}]}', ROOT)).toThrow(LaneReportParseError);
  });
});

const tree = ['tests/unit/a.test.ts', 'tests/unit/guarded.test.ts', 'tests/integration/b.test.ts', 'tests/e2e/c.test.ts'];

function runs(over: Partial<Record<'unit' | 'integration' | 'e2e', ReturnType<typeof file>[] | null>> = {}, exit: Partial<Record<string, number>> = {}): LaneRunInput[] {
  const def: Record<string, ReturnType<typeof file>[]> = {
    unit: [file('tests/unit/a.test.ts', ['passed', 'passed']), file('tests/unit/guarded.test.ts', ['skipped'])],
    integration: [file('tests/integration/b.test.ts', ['passed'])],
    e2e: [file('tests/e2e/c.test.ts', ['passed', 'todo'])],
  };
  return (['unit', 'integration', 'e2e'] as const).map((lane) => {
    const files = lane in over ? over[lane]! : def[lane];
    return { lane, seconds: 10, exitCode: exit[lane] ?? 0, report: files === null ? null : parseVitestJson(report(files), ROOT) };
  });
}

describe('evaluateRun', () => {
  const inv = computeInventory(tree);

  it('success: every file once, no failures, a fully skipped file counts as passing', () => {
    const r = evaluateRun(inv, runs());
    expect(r.reasons).toEqual([]);
    expect(r.outcome).toBe('success');
    expect(r.lanes.find((l) => l.name === 'unit')).toMatchObject({ files: 2, tests: 3, passed: 2, skipped: 1, failed: 0, seconds: 10, gating: true });
  });
  it('a failed test fails the run, named', () => {
    const r = evaluateRun(inv, runs({ integration: [file('tests/integration/b.test.ts', ['passed', 'failed'])] }));
    expect(r.outcome).toBe('failure');
    expect(r.reasons).toContain('file-failed:tests/integration/b.test.ts:1');
    expect(r.reasons).toContain('lane-failed:integration:1');
  });
  it('an inventoried file missing from every report fails', () => {
    const r = evaluateRun(inv, runs({ e2e: [] }));
    expect(r.reasons).toContain('file-not-run:tests/e2e/c.test.ts');
    expect(r.reasons).toContain('lane-zero-passed:e2e');
  });
  it('a file in two lane reports fails', () => {
    const r = evaluateRun(inv, runs({ e2e: [file('tests/e2e/c.test.ts', ['passed']), file('tests/unit/a.test.ts', ['passed'])] }));
    expect(r.reasons).toContain('file-in-multiple-lanes:tests/unit/a.test.ts:unit,e2e');
  });
  it('a file with zero collected tests fails', () => {
    const r = evaluateRun(inv, runs({ unit: [file('tests/unit/a.test.ts', ['passed']), file('tests/unit/guarded.test.ts', [])] }));
    expect(r.reasons).toEqual(['no-tests-collected:tests/unit/guarded.test.ts']);
  });
  it('a lane with zero passed tests fails even when every file collected something', () => {
    const r = evaluateRun(inv, runs({ integration: [file('tests/integration/b.test.ts', ['skipped'])] }));
    expect(r.reasons).toEqual(['lane-zero-passed:integration']);
  });
  it('a missing lane report fails', () => {
    const r = evaluateRun(inv, runs({ integration: null }));
    expect(r.reasons).toContain('lane-report-missing:integration');
    expect(r.reasons).toContain('file-not-run:tests/integration/b.test.ts');
  });
  it('a non-zero exit with no failed test (an unhandled error) fails the lane', () => {
    const r = evaluateRun(inv, runs({}, { unit: 1 }));
    expect(r.reasons).toEqual(['lane-exit-nonzero:unit:1']);
  });
  it('an unlaned stray src test fails the run', () => {
    const r = evaluateRun(computeInventory([...tree, 'src/core/Stray.test.ts']), runs());
    expect(r.reasons).toEqual(['unlaned-test:src/core/Stray.test.ts']);
  });
  it('a failure in an excluded file that a gating lane happened to run still fails the lane', () => {
    const r = evaluateRun(inv, runs({ unit: [file('tests/unit/a.test.ts', ['passed']), file('tests/unit/guarded.test.ts', ['skipped']), file('tests/fixtures/x.test.ts', ['failed'])] }));
    expect(r.reasons).toEqual(['lane-failed:unit:1']);
  });

  describe('gating flag', () => {
    const lanes: LaneDefinition[] = [...LANES, { name: 'flaky' as never, config: 'vitest.flaky.config.ts', include: ['tests/flaky/**'], gating: false }];
    const inv2 = computeInventory([...tree, 'tests/flaky/f.test.ts'], lanes);
    it('a failure only in a non-gating lane does not fail the run, but is reported', () => {
      const lr = [...runs(), { lane: 'flaky' as never, seconds: 3, exitCode: 1, report: parseVitestJson(report([file('tests/flaky/f.test.ts', ['failed'])]), ROOT) }];
      const r = evaluateRun(inv2, lr, lanes);
      expect(r.outcome).toBe('success');
      expect(r.lanes.find((l) => (l.name as string) === 'flaky')).toMatchObject({ gating: false, failed: 1 });
    });
    it('the same failure in a gating lane fails the run', () => {
      const r = evaluateRun(inv, runs({ e2e: [file('tests/e2e/c.test.ts', ['failed', 'passed'])] }));
      expect(r.outcome).toBe('failure');
    });
  });

  it('rejects a report for a lane that is not defined', () => {
    const r = evaluateRun(inv, [...runs(), { lane: 'bogus' as never, seconds: 0, report: null }]);
    expect(r.reasons).toContain('unknown-lane:bogus');
  });
});

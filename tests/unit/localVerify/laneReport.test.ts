/**
 * Tier-1 tests for vitest JSON parsing and the local-verify run predicate
 * (spec local-verify-merge-authority.md §2 step 5). The fixture shape is the
 * one vitest 2.1.9's JsonReporter emits (absolute `name`, file `status`,
 * `assertionResults[].status`).
 */

import { describe, it, expect } from 'vitest';
import { parseVitestJson, evaluateRun, outcomeDigest, testOutcome, OUTCOME_DIGEST_DOMAIN, LaneReportParseError, FAILURE_MESSAGE_MAX, type LaneRunInput } from '../../../src/localVerify/laneReport.js';
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
    expect(r.files.get('tests/unit/a.test.ts')).toMatchObject({ passed: 2, failed: 0, skipped: 2, todo: 1, message: '' });
  });
  it('records the file wall time from start/end when the report carries both, and nothing otherwise', () => {
    const timed = { ...file('tests/unit/a.test.ts', ['passed']), startTime: 1000, endTime: 3500 };
    const untimed = file('tests/unit/b.test.ts', ['passed']) as Record<string, unknown>;
    delete untimed.startTime; delete untimed.endTime;
    const r = parseVitestJson(report([timed, untimed as never]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')!.ms).toBe(2500);
    expect(r.files.get('tests/unit/b.test.ts')!.ms).toBeUndefined();
  });
  it('failed and pending (unfinished or .only) assertions count as failures', () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', ['failed', 'pending', 'passed'])]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')!.failed).toBe(2);
    expect(r.files.get('tests/unit/a.test.ts')).toMatchObject({ assertionFailures: 1, nonAssertionFailure: true });
  });
  it('a file-level failure with no failed assertion (import error) counts one failure', () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', [], 'failed', 'Cannot find module')]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')).toMatchObject({ failed: 1, message: 'Cannot find module' });
    expect(r.files.get('tests/unit/a.test.ts')).toMatchObject({ assertionFailures: 0, nonAssertionFailure: true });
  });
  it('a file-level failure with failed assertions is not double counted', () => {
    const r = parseVitestJson(report([file('tests/unit/a.test.ts', ['failed'])]), ROOT);
    expect(r.files.get('tests/unit/a.test.ts')!.failed).toBe(1);
    expect(r.files.get('tests/unit/a.test.ts')).toMatchObject({ assertionFailures: 1, nonAssertionFailure: false });
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

describe('evaluateRun — fail-fast stopped lanes', () => {
  it('a stoppedEarly flag on a lane that DID report is ignored: its report is judged as usual', async () => {
    const { computeInventory } = await import('../../../src/localVerify/inventory.js');
    const inv = computeInventory(['tests/unit/a.test.ts', 'tests/integration/b.test.ts', 'tests/e2e/c.test.ts']);
    const rep = (f: string, failed: number) => ({ files: new Map([[f, { passed: failed ? 0 : 1, failed, skipped: 0, todo: 0 }]]) });
    const ev = evaluateRun(inv, [
      { lane: 'unit', report: rep('tests/unit/a.test.ts', 1), seconds: 1, exitCode: 1, stoppedEarly: true },
      { lane: 'integration', report: rep('tests/integration/b.test.ts', 0), seconds: 1, exitCode: 0 },
      { lane: 'e2e', report: rep('tests/e2e/c.test.ts', 0), seconds: 1, exitCode: 0 },
    ]);
    expect(ev.outcome).toBe('failure');
    expect(ev.reasons[0]).toBe('lane-failed:unit:1');
    expect(ev.reasons.some((x) => x.startsWith('lane-stopped-early'))).toBe(false);
  });
  it('stopped lanes alone can never make a run succeed', async () => {
    const { computeInventory } = await import('../../../src/localVerify/inventory.js');
    const inv = computeInventory(['tests/unit/a.test.ts', 'tests/integration/b.test.ts', 'tests/e2e/c.test.ts']);
    const ok = (f: string) => ({ files: new Map([[f, { passed: 1, failed: 0, skipped: 0, todo: 0 }]]) });
    const ev = evaluateRun(inv, [
      { lane: 'unit', report: ok('tests/unit/a.test.ts'), seconds: 1, exitCode: 0 },
      { lane: 'integration', report: null, seconds: 1, exitCode: null, stoppedEarly: true },
      { lane: 'e2e', report: ok('tests/e2e/c.test.ts'), seconds: 1, exitCode: 0 },
    ]);
    expect(ev.outcome).toBe('failure');
    expect(ev.reasons).toEqual(['lane-stopped-without-failure', 'lane-stopped-early:integration']);
  });
});

// ── test names in the parser, and the re-run decision (spec local-verify-import-related-rerun.md) ──

import crypto from 'node:crypto';
import { decideIsolationRerun, errorLine, passedByName, type ParsedLaneReport } from '../../../src/localVerify/laneReport.js';

describe('parseVitestJson — test names (import-related re-run)', () => {
  const named = (rel: string, tests: Array<{ name?: string; title?: string; ancestors?: string[]; status: string; msg?: string }>, fileStatus?: 'passed' | 'failed', message = '') => ({
    assertionResults: tests.map((t) => ({
      ancestorTitles: t.ancestors ?? [], ...(t.name !== undefined ? { fullName: t.name } : {}), status: t.status, title: t.title ?? t.name ?? '',
      duration: 1, failureMessages: t.msg !== undefined ? [t.msg] : t.status === 'failed' ? ['boom'] : [], location: null, meta: {},
    })),
    startTime: 1, endTime: 2, status: fileStatus ?? (tests.some((t) => t.status === 'failed') ? 'failed' : 'passed'), message, name: `${ROOT}/${rel}`,
  });
  const F = 'tests/unit/a.test.ts';
  const hashOf = (names: string[]) => { const h = crypto.createHash('sha256'); for (const n of names) h.update(JSON.stringify(n) + '\n'); return h.digest('hex'); };

  it('returns failedTests (name and distinguishing line) for failed files only, and no passedTests on a lane report', () => {
    const r = parseVitestJson(report([
      named(F, [{ name: 's one', status: 'passed' }, { name: 's two', status: 'failed', msg: 'AssertionError: expected 1 to be 2\n    at x.ts:1:1' }]),
      named('tests/unit/b.test.ts', [{ name: 'ok', status: 'passed' }]),
    ] as never), ROOT);
    const a = r.files.get(F)!;
    expect(a.failedTests).toEqual([{ name: 's two', line: 'AssertionError: expected 1 to be 2', full: 'AssertionError: expected 1 to be 2\n    at x.ts:1:1' }]);
    expect(a.passedTests).toBeUndefined();
    const b = r.files.get('tests/unit/b.test.ts')!;
    expect(b.failedTests).toBeUndefined();
    expect(b.testSetHash).toBeUndefined();
    expect(b.passedTests).toBeUndefined();
  });
  it('a solo report carries passedTests and what every other test was', () => {
    const r = parseVitestJson(report([named(F, [{ name: 'a', status: 'passed' }, { name: 'b', status: 'skipped' }, { name: 'c', status: 'todo' }])] as never), ROOT, { solo: true });
    expect(r.files.get(F)!.passedTests).toEqual(['a']);
    expect(r.files.get(F)!.notPassedTests).toEqual([{ name: 'b', status: 'skipped' }, { name: 'c', status: 'todo' }]);
  });
  it('the full name is fullName, or the ancestor titles joined with the title when fullName is absent or empty', () => {
    const r = parseVitestJson(report([named(F, [
      { title: 'does it', ancestors: ['outer', 'inner'], status: 'failed' },
      { name: '', title: 'other', ancestors: ['outer'], status: 'failed' },
    ])] as never), ROOT);
    expect(r.files.get(F)!.failedTests!.map((t) => t.name)).toEqual(['outer inner does it', 'outer other']);
  });
  it('pending and unknown statuses are failed names; the counts are what they were', () => {
    const r = parseVitestJson(report([named(F, [{ name: 'p', status: 'pending' }, { name: 'u', status: 'weird' }, { name: 'ok', status: 'passed' }], 'failed')] as never), ROOT);
    const c = r.files.get(F)!;
    expect(c.failedTests!.map((t) => t.name)).toEqual(['p', 'u']);
    expect(c).toMatchObject({ passed: 1, failed: 2, skipped: 0, todo: 0, assertionFailures: 0, nonAssertionFailure: true });
  });
  it('testSetHash covers every name in report order: a swap of two names changes it, the same order does not', () => {
    const one = parseVitestJson(report([named(F, [{ name: 'a', status: 'failed' }, { name: 'b', status: 'passed' }, { name: 'c', status: 'passed' }])] as never), ROOT).files.get(F)!;
    const same = parseVitestJson(report([named(F, [{ name: 'a', status: 'failed' }, { name: 'b', status: 'passed' }, { name: 'c', status: 'skipped' }])] as never), ROOT).files.get(F)!;
    const swapped = parseVitestJson(report([named(F, [{ name: 'a', status: 'failed' }, { name: 'c', status: 'passed' }, { name: 'b', status: 'passed' }])] as never), ROOT).files.get(F)!;
    expect(one.testSetHash).toBe(hashOf(['a', 'b', 'c']));
    expect(same.testSetHash).toBe(one.testSetHash);
    expect(swapped.testSetHash).not.toBe(one.testSetHash);
    expect(one.duplicateFailedName).toBe(false);
  });
  it('flags a failed name that occurs twice in the file, also across two entries for the same path in one report', () => {
    const twice = parseVitestJson(report([named(F, [{ name: 'x', status: 'failed' }, { name: 'x', status: 'passed' }])] as never), ROOT).files.get(F)!;
    expect(twice.duplicateFailedName).toBe(true);
    const split = parseVitestJson(report([named(F, [{ name: 'x', status: 'failed' }]), named(F, [{ name: 'x', status: 'passed' }, { name: 'y', status: 'passed' }])] as never), ROOT).files.get(F)!;
    expect(split.duplicateFailedName).toBe(true);
    expect(split.testSetHash).toBe(hashOf(['x', 'x', 'y']));
    const passedTwice = parseVitestJson(report([named(F, [{ name: 'x', status: 'failed' }, { name: 'y', status: 'passed' }, { name: 'y', status: 'passed' }])] as never), ROOT).files.get(F)!;
    expect(passedTwice.duplicateFailedName).toBe(false); // only a FAILED name that is not unique counts
  });
  it('reports a file-level failure alone and alongside named failures (S3)', () => {
    const alone = parseVitestJson(report([named(F, [], 'failed', 'Cannot find module')] as never), ROOT).files.get(F)!;
    expect(alone.fileLevelFailure).toBe(true);
    const beside = parseVitestJson(report([named(F, [{ name: 'x', status: 'failed' }, { name: 'y', status: 'passed' }], 'failed', 'beforeAll hook threw')] as never), ROOT).files.get(F)!;
    expect(beside).toMatchObject({ fileLevelFailure: true, failed: 1 });
    const plain = parseVitestJson(report([named(F, [{ name: 'x', status: 'failed' }])] as never), ROOT).files.get(F)!;
    expect(plain.fileLevelFailure).toBe(false);
  });
  it('a failed name over 300 characters is left out, never shortened, and the count stays true (S4)', () => {
    const long = 'n'.repeat(301);
    const c = parseVitestJson(report([named(F, [{ name: long, status: 'failed' }, { name: 'short', status: 'failed' }])] as never), ROOT).files.get(F)!;
    expect(c.failedTests!.map((t) => t.name)).toEqual(['short']);
    expect(c.failed).toBe(2);
  });
  it('errorLine picks the first line that names an error, bounds it and marks a cut', () => {
    expect(errorLine('some preamble\nError: mac-desktop-host-timeout\n    at f (x.ts:1:1)')).toEqual({ line: 'Error: mac-desktop-host-timeout' });
    expect(errorLine('plain words\nmore')).toEqual({ line: 'plain words' });
    const cut = errorLine('AssertionError: ' + 'x'.repeat(900));
    expect(cut.lineCut).toBe(true);
    expect(cut.line.length).toBeLessThanOrEqual(400);
    expect(cut.line).toContain('BOUNDED INPUT');
  });
  it('keeps the whole failure message for the run log, bounded at 8000 with the cut disclosed and the end kept', () => {
    const c = parseVitestJson(report([named(F, [{ name: 'x', status: 'failed', msg: 'Error: head\n' + 'y'.repeat(20_000) + '\nTHE END' }])] as never), ROOT).files.get(F)!;
    expect(c.failedTests![0].full.length).toBeLessThanOrEqual(8000);
    expect(c.failedTests![0].full).toContain('BOUNDED INPUT');
    expect(c.failedTests![0].full.endsWith('THE END')).toBe(true);
  });
  it('passedByName: every failed name must be passed by name; a duplicated name needs as many passes as failures', () => {
    expect(passedByName(['a', 'b'], ['b', 'a', 'c'])).toEqual({ passed: ['a', 'b'], notPassed: [] });
    expect(passedByName(['a', 'b'], ['a', 'c'])).toEqual({ passed: ['a'], notPassed: ['b'] });
    expect(passedByName(['a', 'a'], ['a'])).toEqual({ passed: [], notPassed: ['a', 'a'] });
    expect(passedByName(['a', 'a'], ['a', 'a'])).toEqual({ passed: ['a', 'a'], notPassed: [] });
  });
});

describe('decideIsolationRerun', () => {
  const rep = (m: Record<string, number>): ParsedLaneReport => ({ files: new Map(Object.entries(m).map(([f, failed]) => [f, { passed: 1, failed, skipped: 0, todo: 0 }])) });
  const base = { maxFiles: 3, budgetLeft: 3, unhandledErrors: 0 };
  it('importRelated absent: exactly today\'s result', () => {
    expect(decideIsolationRerun({ ...base, report: rep({ a: 1, b: 0 }), laneFiles: ['a', 'b'] })).toEqual({ rerun: ['a'], reason: 'eligible', threePass: [] });
    expect(decideIsolationRerun({ ...base, report: rep({ a: 1 }), laneFiles: ['a'], ineligible: new Set(['a']) })).toEqual({ rerun: [], reason: 'related-to-change' });
  });
  it('an import-related file with main evidence is eligible and needs three passes', () => {
    expect(decideIsolationRerun({ ...base, report: rep({ a: 1 }), laneFiles: ['a'], ineligible: new Set(), importRelated: new Set(['a']) })).toEqual({ rerun: ['a'], reason: 'eligible', threePass: ['a'] });
  });
  it('an ineligible file in the lane stops everything, also beside an import-related one', () => {
    expect(decideIsolationRerun({ ...base, report: rep({ a: 1, b: 1 }), laneFiles: ['a', 'b'], ineligible: new Set(['b']), importRelated: new Set(['a']) })).toEqual({ rerun: [], reason: 'related-to-change' });
  });
  it('mixed with a plain file: both re-run, only the import-related one needs three passes', () => {
    expect(decideIsolationRerun({ ...base, report: rep({ a: 1, b: 1 }), laneFiles: ['a', 'b'], importRelated: new Set(['b']) })).toEqual({ rerun: ['a', 'b'], reason: 'eligible', threePass: ['b'] });
  });
  it('an import-related file counts as one file against the budget; more than 3 failed files is still a real break', () => {
    expect(decideIsolationRerun({ ...base, budgetLeft: 1, report: rep({ a: 1 }), laneFiles: ['a'], importRelated: new Set(['a']) }).rerun).toEqual(['a']);
    expect(decideIsolationRerun({ ...base, budgetLeft: 1, report: rep({ a: 1, b: 1 }), laneFiles: ['a', 'b'], importRelated: new Set(['a', 'b']) })).toEqual({ rerun: [], reason: 'rerun-budget-spent' });
    expect(decideIsolationRerun({ ...base, report: rep({ a: 1, b: 1, c: 1, d: 1 }), laneFiles: ['a', 'b', 'c', 'd'], importRelated: new Set(['a']) })).toEqual({ rerun: [], reason: 'too-many-failures' });
  });
});

describe('parseVitestJson — the names-and-outcomes digest (borrowed helpers)', () => {
  const F = 'tests/integration/a.test.ts';
  const named = (path: string, tests: Array<{ name: string; status: string }>, fileStatus?: string, message?: string) => ({
    name: `${ROOT}/${path}`, status: fileStatus ?? (tests.some((t) => t.status === 'failed') ? 'failed' : 'passed'), message: message ?? '',
    assertionResults: tests.map((t) => ({ fullName: t.name, title: t.name, status: t.status, failureMessages: t.status === 'failed' ? ['AssertionError: nope'] : [] })),
  });
  const rep = (files: unknown[]) => JSON.stringify({ testResults: files });
  const digestOf = (tests: Array<{ name: string; status: string }>, file = F) => parseVitestJson(rep([named(file, tests)]), ROOT, { outcomeDigest: true }).files.get(file)!.outcomeDigest!;
  const real = [{ name: 'server starts', status: 'passed' }, { name: 'server restarts after a crash', status: 'passed' }, { name: 'server talks to launchd', status: 'skipped' }, { name: 'server drains', status: 'todo' }];

  it('without the option the output is exactly what it was: no digest field on any file, passing or failing', () => {
    const text = rep([named(F, real), named('tests/integration/b.test.ts', [{ name: 'x', status: 'failed' }, { name: 'y', status: 'passed' }])]);
    const plain = parseVitestJson(text, ROOT);
    const solo = parseVitestJson(text, ROOT, { solo: true });
    for (const r of [plain, solo]) for (const c of r.files.values()) expect('outcomeDigest' in c).toBe(false);
    // The option adds the one field and changes nothing else, key order included.
    const withDigest = parseVitestJson(text, ROOT, { outcomeDigest: true });
    for (const [path, c] of withDigest.files) {
      const { outcomeDigest: d, ...restOfFile } = c;
      expect(d).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(restOfFile)).toBe(JSON.stringify(plain.files.get(path)));
    }
    expect(JSON.stringify([...plain.files])).toBe(JSON.stringify([...parseVitestJson(text, ROOT, {}).files]));
  });

  it('the canonical form: the domain line, then one sorted JSON [name, outcome] line per test, SHA-256', () => {
    const lines = [
      JSON.stringify(['server drains', 'todo']), JSON.stringify(['server restarts after a crash', 'passed']),
      JSON.stringify(['server starts', 'passed']), JSON.stringify(['server talks to launchd', 'skipped']),
    ];
    const expected = crypto.createHash('sha256').update(`${OUTCOME_DIGEST_DOMAIN}\n${lines.map((l) => `${l}\n`).join('')}`, 'utf8').digest('hex');
    expect(OUTCOME_DIGEST_DOMAIN).toBe('instar-lv-outcome-digest-v1');
    expect(digestOf(real)).toBe(expected);
    expect(outcomeDigest([])).toBe(crypto.createHash('sha256').update(`${OUTCOME_DIGEST_DOMAIN}\n`, 'utf8').digest('hex'));
  });

  it('does not depend on report order, nor on how a file\'s entries are split', () => {
    expect(digestOf([...real].reverse())).toBe(digestOf(real));
    const split = parseVitestJson(rep([named(F, real.slice(0, 1)), named(F, real.slice(1))]), ROOT, { outcomeDigest: true }).files.get(F)!;
    expect(split.outcomeDigest).toBe(digestOf(real));
    expect([split.passed, split.skipped, split.todo]).toEqual([2, 1, 1]);
  });

  it('equal counts, different tests: a skip swapped for another, or a test replaced, changes the digest', () => {
    const swapped = [{ name: 'server starts', status: 'passed' }, { name: 'server restarts after a crash', status: 'skipped' }, { name: 'server talks to launchd', status: 'passed' }, { name: 'server drains', status: 'todo' }];
    const a = parseVitestJson(rep([named(F, real)]), ROOT, { outcomeDigest: true }).files.get(F)!;
    const b = parseVitestJson(rep([named(F, swapped)]), ROOT, { outcomeDigest: true }).files.get(F)!;
    expect([a.passed, a.failed, a.skipped, a.todo]).toEqual([b.passed, b.failed, b.skipped, b.todo]);
    expect(a.outcomeDigest).not.toBe(b.outcomeDigest);
    const renamed = real.map((t) => (t.name === 'server starts' ? { ...t, name: 'server starts on Linux' } : t));
    expect(digestOf(renamed)).not.toBe(digestOf(real));
    // A skip and a to-do are different outcomes, though both mean "did not run".
    expect(digestOf([{ name: 'x', status: 'skipped' }])).not.toBe(digestOf([{ name: 'x', status: 'todo' }]));
  });

  it('duplicates are kept: a test registered twice differs from once, and two outcomes of one name differ from two equal ones', () => {
    expect(digestOf([{ name: 'x', status: 'passed' }, { name: 'x', status: 'passed' }])).not.toBe(digestOf([{ name: 'x', status: 'passed' }]));
    expect(digestOf([{ name: 'x', status: 'passed' }, { name: 'x', status: 'skipped' }])).not.toBe(digestOf([{ name: 'x', status: 'passed' }, { name: 'x', status: 'passed' }]));
    expect(digestOf([{ name: 'x', status: 'skipped' }, { name: 'x', status: 'passed' }])).toBe(digestOf([{ name: 'x', status: 'passed' }, { name: 'x', status: 'skipped' }]));
  });

  it('uses the outcome classes of the counting rules, not vitest\'s status words', () => {
    expect(['passed', 'skipped', 'disabled', 'todo', 'failed', 'pending', 'weird', undefined, 7].map(testOutcome))
      .toEqual(['passed', 'skipped', 'skipped', 'todo', 'failed', 'failed', 'failed', 'failed', 'failed']);
    expect(digestOf([{ name: 'x', status: 'disabled' }])).toBe(digestOf([{ name: 'x', status: 'skipped' }]));
    expect(digestOf([{ name: 'x', status: 'pending' }])).toBe(digestOf([{ name: 'x', status: 'failed' }]));
    expect(digestOf([{ name: 'x', status: 'passed' }])).not.toBe(digestOf([{ name: 'x', status: 'failed' }]));
  });

  it('a name cannot imitate another line: quotes, commas and newlines in a name are escaped', () => {
    expect(digestOf([{ name: 'a","passed"]\n["b', status: 'passed' }])).not.toBe(digestOf([{ name: 'a', status: 'passed' }, { name: 'b', status: 'passed' }]));
    expect(digestOf([{ name: 'a b', status: 'passed' }])).not.toBe(digestOf([{ name: 'a', status: 'passed' }, { name: 'b', status: 'passed' }]));
  });

  it('every file of the report gets a digest, a failing one included; a file-level failure adds no line and shows in the count', () => {
    const r = parseVitestJson(rep([
      named(F, real),
      named('tests/integration/red.test.ts', [{ name: 'x', status: 'failed' }, { name: 'y', status: 'passed' }]),
      named('tests/integration/broken.test.ts', [], 'failed', 'Cannot find module'),
    ]), ROOT, { outcomeDigest: true });
    expect(r.files.get('tests/integration/red.test.ts')!.outcomeDigest).toBe(outcomeDigest([{ name: 'x', outcome: 'failed' }, { name: 'y', outcome: 'passed' }]));
    const broken = r.files.get('tests/integration/broken.test.ts')!;
    expect(broken.outcomeDigest).toBe(outcomeDigest([]));
    expect(broken.failed).toBe(1);
  });
});

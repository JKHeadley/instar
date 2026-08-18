import { describe, expect, it } from 'vitest';
import {
  classifyVitestListRun,
  evaluateAffectedSmokeSelection,
  evaluateSmokeBreadth,
  failedTestFilesFromVitestJson,
  resolvePrePushBase,
  summarizeVitestListJson,
} from '../../../scripts/lib/pre-push-scope.mjs';

function fakeGit(outputs: Record<string, string | Error>) {
  return (args: string[]) => {
    const key = args.join(' ');
    const value = outputs[key];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected git call: ${key}`);
    return value;
  };
}

describe('pre-push smoke scope helpers', () => {
  it('uses a branch upstream when the upstream branch is main', () => {
    const base = resolvePrePushBase({
      git: fakeGit({
        'branch --show-current': 'codey/fix',
        'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'JKHeadley/main',
        'rev-parse --verify refs/remotes/JKHeadley/main': 'abc123',
      }),
    });

    expect(base).toEqual({ ref: 'JKHeadley/main', reason: 'branch upstream' });
  });

  it('uses the upstream remote main when the branch upstream points at the feature branch', () => {
    const base = resolvePrePushBase({
      git: fakeGit({
        'branch --show-current': 'codey/fix',
        'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'JKHeadley/codey/fix',
        'rev-parse --verify refs/remotes/JKHeadley/main': 'abc123',
      }),
    });

    expect(base).toEqual({ ref: 'JKHeadley/main', reason: 'branch upstream remote main' });
  });

  it('falls back through canonical remotes before origin/main', () => {
    const base = resolvePrePushBase({
      git: fakeGit({
        'branch --show-current': 'codey/fix',
        'rev-parse --abbrev-ref --symbolic-full-name @{u}': new Error('no upstream'),
        'config branch.codey/fix.pushRemote': new Error('unset'),
        'config remote.pushDefault': new Error('unset'),
        'config branch.codey/fix.remote': new Error('unset'),
        'rev-parse --verify refs/remotes/JKHeadley/main': new Error('missing'),
        'rev-parse --verify refs/remotes/upstream/main': 'def456',
      }),
    });

    expect(base).toEqual({ ref: 'upstream/main', reason: 'fallback upstream/main' });
  });

  it('skips local smoke when changed-file count exceeds the cap', () => {
    const result = evaluateSmokeBreadth(
      { changedFileCount: 201, testFileCount: 0, testCaseCount: 0 },
      { maxChangedFiles: 200, maxTestFiles: 80, maxTestCases: 1000 },
    );

    expect(result.skip).toBe(true);
    expect(result.reason).toContain('changed file count 201');
  });

  it('skips local smoke when affected test files exceed the cap', () => {
    const result = evaluateSmokeBreadth(
      { changedFileCount: 5, testFileCount: 81, testCaseCount: 900 },
      { maxChangedFiles: 200, maxTestFiles: 80, maxTestCases: 1000 },
    );

    expect(result.skip).toBe(true);
    expect(result.reason).toContain('affected test file count 81');
  });

  it('summarizes schema-pinned Vitest JSON by entries and unique files', () => {
    const summary = summarizeVitestListJson(JSON.stringify([
      { name: 'suite > case 1', file: '/repo/tests/unit/a.test.ts' },
      { name: 'suite > case 2', file: '/repo/tests/unit/a.test.ts' },
      { name: 'suite > case 1', file: '/repo/tests/integration/b.test.ts' },
    ]));

    expect(summary).toEqual({ testCaseCount: 3, testFileCount: 2 });
  });

  it.each([
    ['empty output', ''],
    ['malformed JSON', '{'],
    ['old rendered output', 'tests/unit/a.test.ts > suite > case 1'],
  ])('refuses %s instead of converting it to zero affected tests', (_label, output) => {
    expect(() => summarizeVitestListJson(output)).toThrow(/Vitest list JSON/);
  });

  it.each([
    ['non-array top level', JSON.stringify({ name: 'case', file: '/repo/tests/a.test.ts' })],
    ['missing file', JSON.stringify([{ name: 'case' }])],
    ['relative file', JSON.stringify([{ name: 'case', file: 'tests/a.test.ts' }])],
    ['unexpected field', JSON.stringify([{ name: 'case', file: '/repo/tests/a.test.ts', status: 'passed' }])],
  ])('fails loudly when the pinned list schema changes: %s', (_label, output) => {
    expect(() => summarizeVitestListJson(output)).toThrow(/Vitest list/);
  });

  it('keeps a genuine structured zero distinct and quiet', () => {
    const summary = summarizeVitestListJson('[]');
    const decision = evaluateAffectedSmokeSelection({ changedFileCount: 1, ...summary });

    expect(summary).toEqual({ testCaseCount: 0, testFileCount: 0 });
    expect(decision).toEqual({ action: 'no-tests', reason: 'structured affected set is empty' });
  });

  it('runs a genuine structured affected set within the caps', () => {
    const summary = summarizeVitestListJson(JSON.stringify([
      { name: 'suite > case 1', file: '/repo/tests/unit/a.test.ts' },
    ]));

    expect(evaluateAffectedSmokeSelection({ changedFileCount: 1, ...summary })).toEqual({
      action: 'run',
      reason: 'structured affected set is within local smoke caps',
    });
  });

  it('keeps the legitimate breadth skip for a large structured affected set', () => {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      name: `suite > case ${index}`,
      file: '/repo/tests/unit/a.test.ts',
    }));
    const summary = summarizeVitestListJson(JSON.stringify(entries));
    const decision = evaluateAffectedSmokeSelection({ changedFileCount: 1, ...summary });

    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('affected test case count 1001');
  });

  it('classifies a list timeout as an explicit non-blocking indeterminate skip with zero tests run', () => {
    expect(classifyVitestListRun({ status: null, signal: 'SIGTERM' })).toEqual({
      action: 'skip-indeterminate',
      reason: 'affected-test listing timed out',
      testsRun: 0,
    });
  });

  it('parses only a successful list process and fails other process errors', () => {
    expect(classifyVitestListRun({ status: 0, signal: null })).toEqual({ action: 'parse' });
    expect(classifyVitestListRun({ status: 2, signal: null })).toEqual({ action: 'fail', exitCode: 2 });
  });

  it('extracts unique failed files from Vitest JSON output', () => {
    const failed = failedTestFilesFromVitestJson(JSON.stringify({
      testResults: [
        {
          name: '/repo/tests/unit/a.test.ts',
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
        {
          name: '/repo/tests/unit/b.test.ts',
          status: 'failed',
          assertionResults: [{ status: 'failed' }],
        },
        {
          name: '/repo/tests/unit/c.test.ts',
          status: 'passed',
          assertionResults: [{ status: 'failed' }],
        },
        {
          name: '/repo/tests/unit/b.test.ts',
          status: 'failed',
          assertionResults: [{ status: 'failed' }],
        },
      ],
    }), { cwd: '/repo' });

    expect(failed).toEqual(['tests/unit/b.test.ts', 'tests/unit/c.test.ts']);
  });

  it('returns an empty list when Vitest JSON has no failed files', () => {
    const failed = failedTestFilesFromVitestJson(JSON.stringify({
      testResults: [
        {
          name: '/repo/tests/unit/a.test.ts',
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
      ],
    }), { cwd: '/repo' });

    expect(failed).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  evaluateSmokeBreadth,
  failedTestFilesFromVitestJson,
  resolvePrePushBase,
  summarizeVitestList,
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

  it('summarizes Vitest list output by test cases and unique files', () => {
    const summary = summarizeVitestList([
      'tests/unit/a.test.ts > suite > case 1',
      'tests/unit/a.test.ts > suite > case 2',
      'tests/integration/b.test.ts > suite > case 1',
      '',
    ].join('\n'));

    expect(summary).toEqual({ testCaseCount: 3, testFileCount: 2 });
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

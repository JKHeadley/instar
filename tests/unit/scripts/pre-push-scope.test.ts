import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  classifySmokeInputs,
  classifyVitestListRun,
  evaluateAffectedSmokeSelection,
  evaluateSmokeBreadth,
  failedTestFilesFromVitestJson,
  resolvePrePushBase,
  summarizeVitestFilesOnlyJson,
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
  it('selects directly changed tests without a related graph for a shared verifier input', () => {
    expect(classifySmokeInputs(['src/localVerify/peer.ts', 'tests/unit/localVerify/peerVerifier.test.ts'])).toMatchObject({
      directTests: ['tests/unit/localVerify/peerVerifier.test.ts'],
      sharedInput: 'src/localVerify/peer.ts',
    });
  });

  it.each([
    'src/server/routes/x.ts', 'tests/setup/x.ts', 'tests/vitest-setup.ts', 'packages/x/package.json',
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'vitest.push.config.ts',
  ])(
    'classifies %s as a shared input before launching related discovery',
    (file) => expect(classifySmokeInputs([file]).sharedInput).toBe(file),
  );

  it('keeps E2E changes visible and does not widen matching to lookalike paths', () => {
    expect(classifySmokeInputs(['tests/e2e/x.test.ts', 'docs/x.mdx'])).toEqual({
      directTests: [], deferredE2e: ['tests/e2e/x.test.ts'], sharedInput: null, hasSourceChange: false,
    });
    for (const file of ['src/commands/server.tsx', 'src/server/routesFoo.ts', 'packages/a/b/package.json']) {
      expect(classifySmokeInputs([file]).sharedInput).toBeNull();
    }
  });

  it.skipIf(process.platform === 'win32')('reuses a single related scan in the smoke CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-smoke-cli-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const selected = path.join(dir, 'tests/unit/one.test.ts');
      const calls = path.join(dir, 'calls.jsonl');
      fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$1 $2" in
  'branch --show-current') echo 'fixture';;
  'rev-parse --abbrev-ref') echo 'origin/main';;
  'rev-parse --verify') echo 'base';;
  'diff --name-only') echo 'src/core/narrow.ts';;
  *) exit 1;;
esac
`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_FIXTURE_CALLS, JSON.stringify(args) + '\\n');
const out = args.find(a => a.startsWith('--json='));
if (out) {
  const entry = { file: process.env.SMOKE_FIXTURE_SELECTED };
  if (!args.includes('--filesOnly')) entry.name = 'fixture case';
  fs.writeFileSync(out.slice(7), JSON.stringify([entry]));
}
`, { mode: 0o755 });
      const script = fileURLToPath(new URL('../../../scripts/pre-push-smoke.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [script], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
          SMOKE_FIXTURE_CALLS: calls,
          SMOKE_FIXTURE_SELECTED: selected,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(invocations.map(args => args[1])).toEqual(['list', 'list', 'run']);
      expect(invocations.filter(args => args.includes('--changed'))).toHaveLength(1);
      expect(invocations[0]).toContain('--filesOnly');
      expect(invocations[1]).toContain(selected);
      expect(invocations[2]).toContain(selected);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'pre-push-scope.test.ts:cleanup' });
    }
  }, 30_000);

  it('keeps the normalized unique files for reuse after the first listing', () => {
    const files = [{ file: '/repo/tests/a.test.ts' }, { file: '/repo/tests/a.test.ts' }, { file: '/repo/tests/b.test.ts' }];
    expect(summarizeVitestFilesOnlyJson(JSON.stringify(files), { includeFiles: true })).toEqual({
      testFileCount: 2, files: ['/repo/tests/a.test.ts', '/repo/tests/b.test.ts'],
    });
  });

  it('retains affected discovery for a narrow source change and avoids it for test-only changes', () => {
    expect(classifySmokeInputs(['src/core/example.ts'])).toMatchObject({ sharedInput: null, hasSourceChange: true });
    expect(classifySmokeInputs(['tests/unit/example.test.ts', 'docs/example.md'])).toMatchObject({
      directTests: ['tests/unit/example.test.ts'], sharedInput: null, hasSourceChange: false,
    });
  });

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

  it('classifies a list timeout as a verification requirement with zero tests run', () => {
    expect(classifyVitestListRun({ status: null, signal: 'SIGTERM' })).toEqual({
      action: 'verify-indeterminate',
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
  it('summarizes a files-only listing (no test cases) and rejects malformed entries', () => {
    expect(
      summarizeVitestFilesOnlyJson(JSON.stringify([{ file: '/repo/tests/a.test.ts' }, { file: '/repo/tests/b.test.ts' }, { file: '/repo/tests/a.test.ts' }])),
    ).toEqual({ testFileCount: 2 });
    expect(summarizeVitestFilesOnlyJson('[]')).toEqual({ testFileCount: 0 });
    expect(() => summarizeVitestFilesOnlyJson('')).toThrow(/empty/);
    expect(() => summarizeVitestFilesOnlyJson('{')).toThrow(/malformed/);
    expect(() => summarizeVitestFilesOnlyJson('{}')).toThrow(/array/);
    expect(() => summarizeVitestFilesOnlyJson(JSON.stringify([{ file: 'relative.test.ts' }]))).toThrow(/absolute/);
  });
});

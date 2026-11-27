// safe-fs-allow: isolated fixture cleanup uses SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../../src/core/SafeGitExecutor.js';
import { realSeams } from '../../../src/localVerify/orchestratorSeams.js';
import { failedFileRunPaths, runFailedFileDiagnosis, type FailedFileDiagnosisSeams } from '../../../src/localVerify/runFailedFileDiagnosis.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, {
  recursive: true, force: true, operation: 'diagnosisWorktrees.test.ts:cleanup' }); });

describe('failed-file diagnosis on exact private git trees', () => {
  it('compares a real PR descendant against its exact passing base without using a suite slot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-diagnosis-trees-'));
    roots.push(root);
    const repo = path.join(root, 'remote');
    const agentHome = path.join(root, 'agent');
    fs.mkdirSync(agentHome);
    SafeGitExecutor.execSync(['init', '-q', repo], { cwd: root, operation: 'diagnosis-worktrees:init' });
    SafeGitExecutor.execSync(['config', 'user.name', 'Diagnosis Test'], { cwd: repo, operation: 'diagnosis-worktrees:config-name' });
    SafeGitExecutor.execSync(['config', 'user.email', 'diagnosis@example.invalid'], { cwd: repo, operation: 'diagnosis-worktrees:config-email' });
    const file = 'tests/unit/a.test.ts';
    const absolute = path.join(repo, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'BASE_PASS\n');
    SafeGitExecutor.execSync(['add', file], { cwd: repo, operation: 'diagnosis-worktrees:add-base' });
    SafeGitExecutor.execSync(['commit', '-q', '-m', 'base'], { cwd: repo, operation: 'diagnosis-worktrees:commit-base' });
    const baseSha = SafeGitExecutor.readSync(['rev-parse', 'HEAD'], { cwd: repo, operation: 'diagnosis-worktrees:base-sha' }).trim();
    fs.writeFileSync(absolute, 'PR_ASSERTION_FAIL\n');
    SafeGitExecutor.execSync(['add', file], { cwd: repo, operation: 'diagnosis-worktrees:add-head' });
    SafeGitExecutor.execSync(['commit', '-q', '-m', 'head'], { cwd: repo, operation: 'diagnosis-worktrees:commit-head' });
    const headSha = SafeGitExecutor.readSync(['rev-parse', 'HEAD'], { cwd: repo, operation: 'diagnosis-worktrees:head-sha' }).trim();
    const request = { repo: 'JKHeadley/instar', pr: 9, headSha, baseSha, baseRefName: 'main',
      verifierVersion: 'v1', policyHash: 'c'.repeat(64), failedFiles: [file],
      attemptId: 'a'.repeat(32), coordinatorMachineId: 'studio', leaseEpoch: 7 };
    const paths = failedFileRunPaths(agentHome, request.attemptId);
    const base = realSeams(() => {}, paths.verifyRoot);
    // Source-loaded seams resolve beside src/*.ts. Production resolves beside
    // the built child, so point this integration fixture at that installed file.
    const installedReporter = path.resolve(process.cwd(), 'dist/localVerify/unhandledErrorsReporter.js');
    expect(fs.existsSync(installedReporter)).toBe(true);
    const seams: FailedFileDiagnosisSeams = { ...base,
      now: () => Date.now(),
      unhandledErrorsReporter: () => installedReporter,
      exec: async (command, args, opts) => {
        if (command === 'npm') return { status: 0, signal: null, pid: null, stdout: '', stderr: '',
          deadlineKilled: false, quiescent: true };
        expect(command.endsWith('/vitest')).toBe(true);
        const content = fs.readFileSync(path.join(opts.cwd, file), 'utf8');
        const failed = content.includes('PR_ASSERTION_FAIL');
        const report = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
        fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: path.join(opts.cwd, file),
          status: failed ? 'failed' : 'passed', assertionResults: [{ status: failed ? 'failed' : 'passed', title: 'test' }] }] }));
        fs.writeFileSync(opts.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE!, JSON.stringify({ v: 1, unhandledErrors: 0, messages: [] }));
        return { status: failed ? 1 : 0, signal: null, pid: null, stdout: '', stderr: '',
          deadlineKilled: false, quiescent: true };
      },
    };
    const result = await runFailedFileDiagnosis({ request, agentHome, remoteUrl: repo, baseEnv: process.env,
      peerMachineId: 'm5', protectedList: ['.github/'] }, seams);
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') return;
    expect(result.answer.classification).toBe('pr-reproducible');
    expect(result.answer.files).toMatchObject([{ file, peerPr: 'assertion-fail', peerBase: 'pass' }]);
    expect(fs.existsSync(paths.root)).toBe(false);
  });
});

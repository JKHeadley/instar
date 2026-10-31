import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedFileRunPaths, runFailedFileDiagnosis, type FailedFileDiagnosisSeams } from '../../../src/localVerify/runFailedFileDiagnosis.js';
import type { DiagnosisPeerRequest } from '../../../src/localVerify/failedFileDiagnosisPeer.js';

const req: DiagnosisPeerRequest = { repo: 'JKHeadley/instar', pr: 9, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  baseRefName: 'main', verifierVersion: 'v1', policyHash: 'c'.repeat(64), failedFiles: ['tests/unit/a.test.ts'],
  attemptId: '1'.repeat(32), coordinatorMachineId: 'studio', leaseEpoch: 4 };
const input = { request: req, agentHome: '/agents/m5', remoteUrl: 'https://github.com/JKHeadley/instar.git',
  baseEnv: { PATH: '/usr/bin' }, peerMachineId: 'm5' };
const sha = (c: string) => c.repeat(40);
const noErrors = JSON.stringify({ v: 1, unhandledErrors: 0, messages: [] });

function fake(opts: { prQuiescent?: boolean; baseFails?: boolean; reporter?: boolean } = {}) {
  const paths = failedFileRunPaths(input.agentHome, req.attemptId);
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: string[] = [];
  let now = 0;
  const seams = {
    now: () => now,
    unhandledErrorsReporter: () => opts.reporter === false ? null : '/installed/reporter.js',
    fs: {
      exists: (p: string) => dirs.has(p),
      mkdirp: (p: string) => { dirs.add(p); },
      writeFile: (p: string, content: string) => { files.set(p, content); },
      readFile: (p: string) => files.get(p) ?? null,
      mkdtemp: (prefix: string) => `/tmp/${prefix}${calls.length}`,
      removeTree: async (p: string) => { dirs.delete(p); calls.push(`remove:${p}`); },
    },
    git: async (args: string[], config: { timeoutMs: number }) => {
      expect(config.timeoutMs).toBeLessThanOrEqual(5 * 60_000);
      calls.push(`git:${args[0]}`);
      now += 100;
      const stdout = args[0] === 'merge-tree' ? sha('d') : args[0] === 'commit-tree' ? sha('e') : '';
      return { status: 0, stdout, stderr: '', timedOut: false };
    },
    exec: async (command: string, args: string[], config: { cwd: string; env: NodeJS.ProcessEnv; isolatedGroup: true }) => {
      expect(config.isolatedGroup).toBe(true);
      expect(config.env.TMPDIR).toMatch(/^\/tmp\/lv-diagnosis-/);
      calls.push(`exec:${path.basename(command)}:${args[0]}`);
      now += 1000;
      if (path.basename(command) !== 'vitest') return { status: 0, signal: null, stdout: '', stderr: '', deadlineKilled: false, pid: 2, quiescent: true };
      const phase = config.cwd === paths.pr ? 'pr' : 'base';
      const failed = phase === 'pr' || opts.baseFails === true;
      const reportPath = args.find((a) => a.startsWith('--outputFile='))!.slice('--outputFile='.length);
      files.set(reportPath, JSON.stringify({ testResults: [{ name: path.join(config.cwd, req.failedFiles[0]),
        status: failed ? 'failed' : 'passed', assertionResults: [{ status: failed ? 'failed' : 'passed', title: 'test' }] }] }));
      files.set(config.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE!, noErrors);
      return { status: failed ? 1 : 0, signal: null, stdout: '', stderr: '', deadlineKilled: false, pid: 3,
        quiescent: phase !== 'pr' || opts.prQuiescent !== false };
    },
  } as unknown as FailedFileDiagnosisSeams;
  return { seams, calls, dirs, paths };
}

describe('bounded peer failed-file runner', () => {
  it('compares the same file on exact PR merge and base without a full-suite slot', async () => {
    const f = fake();
    const r = await runFailedFileDiagnosis(input, f.seams);
    expect(r.kind).toBe('done');
    if (r.kind !== 'done') return;
    expect(r.answer).toMatchObject({ classification: 'pr-reproducible', peerMachineId: 'm5',
      files: [{ file: req.failedFiles[0], peerPr: 'assertion-fail', peerBase: 'pass' }] });
    expect(f.calls.filter((c) => c.includes('vitest'))).toHaveLength(2);
    expect(f.calls.some((c) => c.includes('holdSuiteSlot'))).toBe(false);
    expect(f.dirs.has(f.paths.root)).toBe(false);
  });

  it('returns a base-or-shared observation when both trees fail the file', async () => {
    const r = await runFailedFileDiagnosis(input, fake({ baseFails: true }).seams);
    expect(r.kind === 'done' && r.answer.classification).toBe('base-or-shared');
  });

  it('refuses to clear an unconfirmed worker group before another verify', async () => {
    const f = fake({ prQuiescent: false });
    const r = await runFailedFileDiagnosis(input, f.seams);
    expect(r.kind).toBe('unsafe-cleanup');
    expect(f.calls.filter((c) => c.includes('vitest'))).toHaveLength(1);
    expect(f.dirs.has(f.paths.root)).toBe(true);
  });

  it('is inconclusive without the installed trusted reporter', async () => {
    const f = fake({ reporter: false });
    const r = await runFailedFileDiagnosis(input, f.seams);
    expect(r.kind === 'done' && r.answer.classification).toBe('inconclusive');
    expect(f.calls.filter((c) => c.startsWith('exec:'))).toHaveLength(0);
  });
});

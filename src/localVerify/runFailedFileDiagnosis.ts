/** One peer's bounded, advisory-only comparison of failed test files on PR and base. */
import path from 'node:path';
import { classifyComparisonSet, type DiagnosisFileComparison, type DiagnosisIdentity, type FileObservation } from './failedFileDiagnosis.js';
import type { DiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';
import { vitestConfigForTestPath } from './inventory.js';
import { parseVitestJson } from './laneReport.js';
import { bareConfigTemplate, type ExecResult, type OrchestratorSeams } from './orchestrator.js';
import { readUnhandledErrors } from './unhandledErrorsReporter.js';

export const FAILED_FILE_RUN_LIMITS = Object.freeze({ totalMs: 15 * 60_000, perFileMs: 90_000, cleanupReserveMs: 10_000, reportMaxBytes: 10 * 1024 * 1024 });

export interface FailedFileRunInput {
  request: DiagnosisPeerRequest;
  agentHome: string;
  remoteUrl: string;
  baseEnv: NodeJS.ProcessEnv;
  peerMachineId: string;
}

/** The peer adapter must prove its detached child group is empty after each command. */
export interface FailedFileDiagnosisSeams extends Omit<OrchestratorSeams, 'exec'> {
  exec(command: string, args: string[], opts: {
    cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; isolatedGroup: true;
  }): Promise<ExecResult & { quiescent: boolean }>;
}

export type FailedFileRunResult =
  | { kind: 'done'; answer: {
    attemptId: string; identity: DiagnosisIdentity; peerMachineId: string; coordinatorMachineId: string; leaseEpoch: number | null;
    classification: ReturnType<typeof classifyComparisonSet>; files: DiagnosisFileComparison[]; machineMinutes: number; reason?: string;
  } }
  | { kind: 'unsafe-cleanup'; reason: string };

class Inconclusive extends Error {}

export function failedFileRunPaths(agentHome: string, attemptId: string) {
  const verifyRoot = path.join(agentHome, '.worktrees', '.verify');
  const root = path.join(verifyRoot, 'diagnosis', attemptId);
  return { verifyRoot, root, bare: path.join(root, 'repo.git'), pr: path.join(root, 'pr'), base: path.join(root, 'base'), reports: path.join(root, 'reports') };
}

export async function runFailedFileDiagnosis(input: FailedFileRunInput, seams: FailedFileDiagnosisSeams): Promise<FailedFileRunResult> {
  const { request: req } = input;
  const p = failedFileRunPaths(input.agentHome, req.attemptId);
  const started = seams.now();
  const reporter = seams.unhandledErrorsReporter?.() ?? null;
  const temps: string[] = [];
  let prAdded = false;
  let baseAdded = false;
  let reason: string | undefined;
  let files: DiagnosisFileComparison[] = [];
  let uncertainWorkers = false;
  let reportBytes = 0;
  const remaining = () => FAILED_FILE_RUN_LIMITS.totalMs - (seams.now() - started);
  const budget = (limit: number) => {
    const ms = Math.min(limit, remaining() - FAILED_FILE_RUN_LIMITS.cleanupReserveMs);
    if (ms <= 0) throw new Inconclusive('aggregate-deadline');
    return Math.max(1, ms);
  };
  const git = async (args: string[], step: string, wt?: { gitDir: string; workTree: string }, maxMs = 120_000) => {
    const r = await seams.git(args, { cwd: wt ? wt.workTree : p.root,
      gitDir: wt ? wt.gitDir : p.bare, ...(wt ? { workTree: wt.workTree } : {}),
      operation: `local-verify:diagnosis:${step}`, timeoutMs: budget(maxMs) });
    if (r.timedOut || r.status !== 0) throw new Inconclusive(`${step}-${r.timedOut ? 'timeout' : 'failed'}`);
    return r.stdout.trim();
  };
  const run = async (command: string, args: string[], cwd: string, step: string, maxMs: number, extraEnv: NodeJS.ProcessEnv = {}) => {
    const tmp = seams.fs.mkdtemp('lv-diagnosis-tmp-');
    const tmux = seams.fs.mkdtemp('lv-diagnosis-tmux-');
    temps.push(tmp, tmux);
    const env = { ...input.baseEnv, ...extraEnv, TMPDIR: tmp, TMUX_TMPDIR: tmux,
      PATH: [path.join(cwd, 'node_modules', '.bin'), input.baseEnv.PATH ?? ''].filter(Boolean).join(path.delimiter) };
    let r: ExecResult & { quiescent: boolean };
    try { r = await seams.exec(command, args, { cwd, env, deadlineMs: budget(maxMs), isolatedGroup: true }); }
    catch { uncertainWorkers = true; throw new Inconclusive(`${step}-process-state-unknown`); }
    if (r.quiescent !== true) { uncertainWorkers = true; throw new Inconclusive(`${step}-workers-unconfirmed`); }
    if (r.deadlineKilled || r.aborted) throw new Inconclusive(`${step}-timeout-or-cancelled`);
    return r;
  };
  const observeFile = async (tree: string, phase: 'pr' | 'base', file: string, index: number): Promise<FileObservation> => {
    const report = path.join(p.reports, `${phase}-${index}.json`);
    const errors = path.join(p.reports, `${phase}-${index}.errors.json`);
    const args = ['run', '--config', vitestConfigForTestPath(file), '--allowOnly=false', '--reporter=json',
      `--reporter=${reporter}`, `--outputFile=${report}`, file];
    const r = await run(path.join(tree, 'node_modules', '.bin', 'vitest'), args, tree, `${phase}-${index}`, FAILED_FILE_RUN_LIMITS.perFileMs,
      { LOCAL_VERIFY_UNHANDLED_ERRORS_FILE: errors });
    const raw = seams.fs.readFile(report);
    const errorsRaw = seams.fs.readFile(errors);
    reportBytes += Buffer.byteLength(raw ?? '') + Buffer.byteLength(errorsRaw ?? '');
    if (!raw || reportBytes > FAILED_FILE_RUN_LIMITS.reportMaxBytes || readUnhandledErrors(errorsRaw) !== 0) return 'unknown';
    try {
      const parsed = parseVitestJson(raw, tree);
      const result = parsed.files.get(file);
      if (!result || parsed.files.size !== 1) return 'unknown';
      if (r.status === 0 && result.failed === 0 && result.passed > 0) return 'pass';
      if (typeof r.status === 'number' && r.status > 0 && result.failed > 0) return 'assertion-fail';
    } catch { /* malformed or incomplete report is unknown */ }
    return 'unknown';
  };

  try {
    if (!reporter) throw new Inconclusive('installed-reporter-missing');
    seams.fs.mkdirp(p.root);
    seams.fs.mkdirp(p.reports);
    await git(['init', '--bare', '--quiet', p.bare], 'init');
    seams.fs.writeFile(path.join(p.bare, 'config'), bareConfigTemplate(input.remoteUrl));
    await git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', req.headSha, req.baseSha], 'fetch', undefined, 5 * 60_000);
    const tree = await git(['merge-tree', '--write-tree', req.baseSha, req.headSha], 'merge-tree');
    if (!/^[0-9a-f]{40}$/.test(tree)) throw new Inconclusive('merge-tree-invalid');
    const merge = await git(['commit-tree', tree, '-p', req.baseSha, '-p', req.headSha, '-m', 'diagnosis merge'], 'commit-tree');
    if (!/^[0-9a-f]{40}$/.test(merge)) throw new Inconclusive('merge-commit-invalid');
    await git(['worktree', 'add', '--detach', p.pr, merge], 'worktree-pr');
    prAdded = true;
    await git(['worktree', 'add', '--detach', p.base, req.baseSha], 'worktree-base');
    baseAdded = true;
    for (const [name, treeDir] of [['pr', p.pr], ['base', p.base]] as const) {
      const ci = await run('npm', ['ci', '--no-audit', '--no-fund'], treeDir, `${name}-install`, 10 * 60_000, { HUSKY: '0' });
      if (ci.status !== 0) throw new Inconclusive(`${name}-install-failed`);
      const build = await run('npm', ['run', 'build'], treeDir, `${name}-build`, 5 * 60_000);
      if (build.status !== 0) throw new Inconclusive(`${name}-build-failed`);
    }
    files = [];
    for (const [index, file] of req.failedFiles.entries()) {
      const peerPr = await observeFile(p.pr, 'pr', file, index);
      const peerBase = await observeFile(p.base, 'base', file, index);
      files.push({ file, originalPr: 'assertion-fail', peerPr, peerBase });
      if (peerPr === 'unknown' || peerBase === 'unknown') { reason = 'file-result-indeterminate'; break; }
    }
  } catch (error) {
    reason = error instanceof Inconclusive ? error.message : `runner-error:${error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100)}`;
  }

  // Cleanup is part of the same 15-minute attempt. A worker that cannot be
  // proved gone is a peer-slot hold, never permission to start a full verify.
  if (uncertainWorkers) return { kind: 'unsafe-cleanup', reason: (reason ?? 'workers-unconfirmed').slice(0, 160) };
  const cleanupErrors: string[] = [];
  const cleanupGit = async (args: string[], step: string) => {
    try {
      const r = await seams.git(args, { cwd: p.root, gitDir: p.bare, operation: `local-verify:diagnosis:${step}`,
        timeoutMs: Math.max(1_000, Math.min(10_000, remaining())) });
      if (r.status !== 0 || r.timedOut) cleanupErrors.push(step);
    } catch { cleanupErrors.push(step); }
  };
  if (baseAdded) await cleanupGit(['worktree', 'remove', '--force', p.base], 'remove-base');
  if (prAdded) await cleanupGit(['worktree', 'remove', '--force', p.pr], 'remove-pr');
  for (const tmp of temps) {
    try { await seams.fs.removeTree(tmp); } catch { cleanupErrors.push('remove-temp'); }
  }
  try { if (seams.fs.exists(p.root)) await seams.fs.removeTree(p.root); } catch { cleanupErrors.push('remove-root'); }
  if (cleanupErrors.length) return { kind: 'unsafe-cleanup', reason: cleanupErrors.join(',').slice(0, 160) };
  const { attemptId: _attempt, coordinatorMachineId: _coordinator, leaseEpoch: _epoch, ...identity } = req;
  void _attempt; void _coordinator; void _epoch;
  const classification = reason ? 'inconclusive' : classifyComparisonSet(files, req.failedFiles);
  return { kind: 'done', answer: { attemptId: req.attemptId, identity, peerMachineId: input.peerMachineId,
    coordinatorMachineId: req.coordinatorMachineId, leaseEpoch: req.leaseEpoch, classification, files,
    machineMinutes: Math.min(15, Math.max(0, seams.now() - started) / 60_000), ...(reason ? { reason: reason.slice(0, 160) } : {}) } };
}

/**
 * agentWorktreeEvaluationJob — the AgentWorktreeReaper's dry-run pass, OFF the
 * server's main thread.
 *
 * Why: `AgentWorktreeReaper.evaluate()` is synchronous (git status, ls-files,
 * cherry, gh, ps/lsof through execFileSync). Measured on the Mac Studio on
 * 2026-11-18 in a separate read-only process: a 40-checkout sample took 6.9 s
 * (mean 173 ms per checkout); over 258 checkouts that projects to about 45 s of
 * blocked event loop per pass, 15 minutes after every boot and daily, plus every
 * read of GET /worktrees/agent-reaper (fb-91e824f4-920). Same move as the hourly
 * backup snapshot (backupSnapshotJob.ts, PR 3134).
 *
 * Shape: the worker builds the same production deps from plain options, runs the
 * same preparation (link index) and the same evaluate() per checkout, and posts
 * the evaluations back. Removal never happens here: a dry-run pass only reports,
 * and a live pass (dryRun false) keeps the in-process path. The worker entry
 * (agentWorktreeEvaluation.worker.ts) holds no logic.
 */
import os from 'node:os';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AgentWorktreeReaper, type WorktreeEvaluation, type WorktreeEnumeration } from './AgentWorktreeReaper.js';
import { makeAgentWorktreeReaperDeps } from './agentWorktreeGit.js';
import { NodeModulesMemo, runNodeModulesPass, readNpmMajor, type NodeModulesPassSummary } from './agentWorktreeNodeModules.js';

export interface AgentWorktreeEvaluationInput {
  instarRepo: string;
  worktreesDir: string;
  githubMergeCheck: boolean;
  gateRecordArchiveDir?: string;
  /**
   * The root node_modules proof's state folder (spec reaper-node-modules-regenerable).
   * Absent ⇒ a real root node_modules stays `work`, as before.
   */
  nodeModulesStateDir?: string;
  /** At most this many checkouts are hashed per pass (the reaper's maxReapsPerPass). */
  maxHashesPerPass?: number;
  npmPath?: string;
  /** Test seam: npm's major version without running npm. */
  npmMajor?: string | null;
}

export type AgentWorktreeEvaluationResult = WorktreeEnumeration<WorktreeEvaluation> & { archiveBytes?: number | null; nodeModules?: NodeModulesPassSummary | null; linkIndex?: string };

/** The whole off-thread half. Async only for the link index; a test can run it in-process. */
export async function runAgentWorktreeEvaluation(input: AgentWorktreeEvaluationInput): Promise<AgentWorktreeEvaluationResult> {
  const memo = input.nodeModulesStateDir ? new NodeModulesMemo(input.nodeModulesStateDir) : undefined;
  const made = makeAgentWorktreeReaperDeps({
    instarRepo: input.instarRepo,
    worktreesDir: input.worktreesDir,
    githubMergeCheck: input.githubMergeCheck,
    ...(input.gateRecordArchiveDir ? { gateRecordArchiveDir: input.gateRecordArchiveDir } : {}),
    ...(memo ? { nodeModulesMemo: memo } : {}),
  });
  const deps = {
    ...made,
    // Read-only: this path has no way to remove a worktree.
    removeWorktree: (): void => { throw new Error('agent worktree evaluation worker: removal is not available here'); },
  };
  const reaper = new AgentWorktreeReaper(deps, { enabled: false, dryRun: true });
  await reaper.prepare();
  const enumeration = deps.listWorktrees();
  if (!enumeration.ok) return enumeration;
  // The root node_modules verdicts for this pass (spec reaper-node-modules-regenerable §4):
  // computed once, here, in dry-run; classifyIgnoredEntry reads them through the memo.
  let nodeModules: NodeModulesPassSummary | null = null;
  if (memo && input.nodeModulesStateDir) {
    nodeModules = runNodeModulesPass({
      deps: { isInUse: deps.isInUse, isMerged: deps.isMerged, isCleanExceptRootNodeModules: deps.isCleanExceptRootNodeModules },
      worktrees: enumeration.worktrees, memo, refsDir: input.nodeModulesStateDir, archiveRoot: made.gateRecordArchiveDir,
      maxHashes: input.maxHashesPerPass ?? 20,
      npmMajor: input.npmMajor !== undefined ? input.npmMajor : readNpmMajor(input.npmPath ?? 'npm', os.tmpdir()),
      passId: crypto.randomBytes(8).toString('hex'),
    });
  }
  const worktrees = enumeration.worktrees.map((info): WorktreeEvaluation => {
    // annotate(): report-only node_modules kind + dry-run projection (spec reaper-generated-files-regenerable §5).
    let evaln: WorktreeEvaluation;
    try { evaln = reaper.annotate(reaper.evaluate(info), true); }
    catch { evaln = { path: info.path, branch: info.branch, verdict: 'keep', reason: 'eval-error' }; }
    const check = nodeModules?.checks[info.path];
    if (check) evaln.nodeModulesCheck = check;
    return evaln;
  });
  return { ok: true, worktrees, archiveBytes: reaper.measureArchive(), nodeModules, linkIndex: deps.linkIndexStatus() };
}

export interface AgentWorktreeEvaluationWorkerOptions extends AgentWorktreeEvaluationInput {
  /**
   * A worker still running after this long is ended and the pass is a failure.
   * Without it, a worker stuck in an unbounded filesystem call would keep the
   * reaper's overlap guard set and silently skip every later pass. The measured
   * pass is about 45 s; the default allows 40 times that.
   */
  timeoutMs?: number;
  /** Test seam: where the compiled worker entry lives. */
  workerUrl?: URL;
}

export const DEFAULT_EVALUATION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Evaluate every checkout in a worker. Resolves with the evaluations, or with
 * `{ ok: false, error }` when the worker fails, exits early or times out, which
 * the reaper records exactly like an enumeration failure (reclaimable unknown,
 * keep everything). Never rejects.
 */
export function evaluateAgentWorktreesInWorker(options: AgentWorktreeEvaluationWorkerOptions): Promise<AgentWorktreeEvaluationResult> {
  const input: AgentWorktreeEvaluationInput = {
    instarRepo: options.instarRepo,
    worktreesDir: options.worktreesDir,
    githubMergeCheck: options.githubMergeCheck,
    ...(options.gateRecordArchiveDir ? { gateRecordArchiveDir: options.gateRecordArchiveDir } : {}),
    ...(options.nodeModulesStateDir ? { nodeModulesStateDir: options.nodeModulesStateDir } : {}),
    ...(options.maxHashesPerPass !== undefined ? { maxHashesPerPass: options.maxHashesPerPass } : {}),
    ...(options.npmPath ? { npmPath: options.npmPath } : {}),
  };
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      // The server's own environment: the merged-PR check authenticates `gh` through
      // GH_TOKEN, and a stripped environment would silently read every squash-merged
      // branch as unmerged.
      worker = new Worker(options.workerUrl ?? new URL('./agentWorktreeEvaluation.worker.js', import.meta.url), { workerData: input, env: process.env });
    } catch (error) {
      resolve({ ok: false, error: `evaluation worker could not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    let settled = false;
    const settle = (result: AgentWorktreeEvaluationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      settle({ ok: false, error: `evaluation worker still running after ${Math.round(timeoutMs / 1000)} s; ended` });
      void worker.terminate();
    }, timeoutMs);
    timer.unref?.();
    worker.once('message', (message: AgentWorktreeEvaluationResult) => {
      settle(message && typeof message === 'object' && 'ok' in message ? message : { ok: false, error: 'evaluation worker returned no result' });
    });
    worker.once('error', (error) => settle({ ok: false, error: `evaluation worker failed: ${error instanceof Error ? error.message : String(error)}` }));
    worker.once('exit', (code) => settle({ ok: false, error: `evaluation worker exited (code ${code}) before reporting` }));
  });
}

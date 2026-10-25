/**
 * Real seams for the local-verify orchestrator. Used only inside the
 * `runVerifyMain` child process (never on the server's event loop), so the
 * synchronous git funnel blocks nothing that matters.
 *
 * - git: every call goes through SafeGitExecutor with the `localVerifyCloneOk`
 *   carve-out anchored to THIS agent's verifyRoot, with GIT_DIR / GIT_WORK_TREE /
 *   GIT_CEILING_DIRECTORIES pinned so git never searches upward for a repository.
 * - fs deletes: SafeFsExecutor, and only inside THIS agent's verifyRoot or the
 *   run's own `lv-` temp directories (refused anywhere else, before the funnel).
 * - processes: plain spawn in the child's own process group (the service started
 *   the child detached), deadline = SIGTERM then SIGKILL.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeGitExecutor, isLocalVerifyClonePath } from '../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { getHostTestRunnerSemaphore, TestRunnerCapacityTimeoutError, TestRunnerStormCeilingError } from '../core/hostTestRunnerSemaphore.js';
import { fileURLToPath } from 'node:url';
import type { ExecResult, GitCallOpts, GitResult, OrchestratorSeams } from './orchestrator.js';
import { localImportGraph } from './verifierVersion.js';

/** The trusted unhandled-errors reporter installed next to this module (dist), or null. */
export function installedUnhandledErrorsReporter(): string | null {
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'unhandledErrorsReporter.js');
  return fs.existsSync(f) ? f : null;
}

const OUTPUT_TAIL = 64 * 1024;
const KILL_GRACE_MS = 5_000;
const TEMP_PREFIX = 'lv-';

/**
 * Where per-run temp folders go: `/tmp` when it exists (POSIX), else the OS temp dir.
 * macOS's per-user temp dir is ~50 characters deep, and tests that open a Unix socket
 * under TMPDIR then exceed the 104-character socket-path limit (`listen EINVAL`):
 * found on the first full real runs, where four socket tests failed only under the
 * verifier.
 */
export function localVerifyTempRoot(): string {
  try {
    if (process.platform !== 'win32' && fs.statSync('/tmp').isDirectory()) return fs.realpathSync('/tmp');
  } catch { /* @silent-fallback-ok — no /tmp: the OS temp dir is the only option */ }
  return os.tmpdir();
}

/** True when `target` is one of the run's own temp directories (`<tmpdir>/lv-…`). */
export function isLocalVerifyTempPath(target: string, tmpRoot = localVerifyTempRoot()): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const root = real(tmpRoot);
  const t = real(target);
  const rel = path.relative(root, t);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0].startsWith(TEMP_PREFIX);
}

/** Recursive delete, refused outside THIS agent's verifyRoot and the run's own temp dirs. */
export async function removeScopedTree(target: string, verifyRoot: string): Promise<void> {
  const inRoot = isLocalVerifyClonePath(target, verifyRoot);
  if (!inRoot && !isLocalVerifyTempPath(target)) {
    throw new Error(`local-verify refuses to delete outside ${verifyRoot} or its temp dirs: ${target}`);
  }
  await SafeFsExecutor.safeRm(target, {
    recursive: true, force: true, operation: 'local-verify:remove-tree',
    ...(inRoot ? { localVerifyScopeOk: { verifyRoot } } : {}),
  });
}

function tail(s: string): string {
  return s.length > OUTPUT_TAIL ? s.slice(s.length - OUTPUT_TAIL) : s;
}

export function realGit(args: string[], opts: GitCallOpts, verifyRoot: string): Promise<GitResult> {
  try {
    const stdout = SafeGitExecutor.run(args, {
      cwd: opts.cwd, operation: opts.operation, timeout: opts.timeoutMs,
      localVerifyCloneOk: { verifyRoot, gitDir: opts.gitDir, ...(opts.workTree ? { workTree: opts.workTree } : {}) },
      maxBuffer: 256 * 1024 * 1024,
    });
    return Promise.resolve({ status: 0, stdout, stderr: '', timedOut: false });
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer; code?: string; signal?: string; message?: string };
    const timedOut = err.code === 'ETIMEDOUT' || (err.signal === 'SIGTERM' && err.status == null);
    return Promise.resolve({
      status: typeof err.status === 'number' ? err.status : null,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      timedOut,
    });
  }
}

export function realExec(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; onPid?: (pid: number) => void },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid && opts.onPid) opts.onPid(child.pid);
    let stdout = '';
    let stderr = '';
    let deadlineKilled = false;
    child.stdout?.on('data', (d) => { stdout = tail(stdout + d.toString()); });
    child.stderr?.on('data', (d) => { stderr = tail(stderr + d.toString()); });
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      deadlineKilled = true;
      try { child.kill('SIGTERM'); } catch { /* @silent-fallback-ok: already gone */ }
      hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* @silent-fallback-ok: already gone */ } }, KILL_GRACE_MS);
    }, Math.max(1, opts.deadlineMs));
    const done = (status: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      resolve({ status, signal, stdout, stderr, deadlineKilled, pid: child.pid ?? null });
    };
    child.on('close', (status, signal) => done(status ?? null, signal ?? null));
    child.on('error', (e) => { stderr = tail(stderr + String(e.message)); done(null, null); });
  });
}

/** `verifyRoot` is `<agentHome>/.worktrees/.verify` of the agent running the verify. */
export function realSeams(log: (event: Record<string, unknown>) => void, verifyRoot: string): OrchestratorSeams {
  return {
    git: (args, opts) => realGit(args, opts, verifyRoot),
    exec: realExec,
    fs: {
      exists: (p) => fs.existsSync(p),
      mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
      writeFile: (p, data) => { fs.writeFileSync(p, data); },
      readFile: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
      mkdtemp: (prefix) => fs.mkdtempSync(path.join(localVerifyTempRoot(), prefix.startsWith(TEMP_PREFIX) ? prefix : TEMP_PREFIX + prefix)),
      removeTree: (p) => removeScopedTree(p, verifyRoot),
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    foreignSuiteHolders: (ours) => {
      try {
        return getHostTestRunnerSemaphore().status().liveHolders
          .filter((h) => !ours.has(h.pid) && h.pid !== process.pid)
          .map((h) => ({ pid: h.pid }));
      } catch {
        // @silent-fallback-ok: an unreadable holders file is "no observation"; the bound is watch-only.
        return [];
      }
    },
    holdSuiteSlot: () => holdSuiteSlot(log),
    log,
    importGraph: (files) => localImportGraph(files),
    unhandledErrorsReporter: installedUnhandledErrorsReporter,
  };
}

/** How long the lane phase waits for its suite slot before re-queueing the verify. */
const SUITE_SLOT_ACQUIRE_MS = 60_000;

/**
 * One full-suite slot for a verify's lane phase, held by the verify child process
 * (runVerifyMain). The lanes are its children, so the bound's ancestry check nests each
 * lane's own request under this slot; if the verify process dies, the slot is reclaimed
 * with it (dead pid).
 * Busy (another suite holds it) or an internal error of the bound ⇒ 'busy': the verify
 * re-queues without counting an attempt. A fail-open admit (the bound cannot confirm a
 * host-local disk) ⇒ null: the lanes run, and their own requests fail open the same way.
 */
async function holdSuiteSlot(log: (event: Record<string, unknown>) => void): Promise<(() => void) | 'busy' | null> {
  const sem = getHostTestRunnerSemaphore();
  try {
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: SUITE_SLOT_ACQUIRE_MS });
    if (out.kind !== 'acquired') {
      log({ event: 'suite-slot', outcome: 'fail-open-admit', cause: out.cause });
      return null;
    }
    log({ event: 'suite-slot', outcome: 'acquired', wouldBlock: out.wouldBlock });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { sem.release(out.id); } catch (e) {
        // @silent-fallback-ok: a failed release is reclaimed by the bound (dead pid / TTL); logged.
        log({ event: 'suite-slot', outcome: 'release-failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
    };
  } catch (e) {
    if (e instanceof TestRunnerCapacityTimeoutError || e instanceof TestRunnerStormCeilingError) {
      log({ event: 'suite-slot', outcome: 'busy' });
      return 'busy';
    }
    // An internal error of the bound: re-queue rather than run four lane processes that
    // would each wait for the same cap-1 slot (a false failure). The starved signal covers
    // a bound that keeps failing.
    log({ event: 'suite-slot', outcome: 'error', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return 'busy';
  }
}

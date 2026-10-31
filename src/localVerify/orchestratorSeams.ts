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
 *   the child detached); a deadline or a fail-fast stop = SIGTERM then SIGKILL to the
 *   process AND its descendants, and the wait for its pipes is bounded once it has exited.
 */

import { execFileSync, spawn } from 'node:child_process';
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

/**
 * One `ps` snapshot: pid → { ppid, start }. `start` is the process's identity for the SIGKILL
 * re-check: its start time (`lstart`, whole seconds) plus its command name (`comm`). Both macOS
 * and Linux allocate pids sequentially up to a large maximum before wrapping, so a pid reused
 * within the same second is already implausible; requiring the same command as well closes it.
 */
export function psSnapshot(psOutput?: string): Map<number, { ppid: number; start: string }> | null {
  let text = psOutput;
  if (text === undefined) {
    try { text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf-8', timeout: 5_000 }); } catch { return null; } // @silent-fallback-ok: no ps ⇒ only the direct child is signalled (the bounded close still ends the wait)
  }
  const out = new Map<number, { ppid: number; start: string }>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), start: m[3].trim().replace(/\s+/g, ' ') });
  }
  return out;
}

/**
 * Every live descendant of `pid` with its start time, from one snapshot. Taken BEFORE the
 * parent is signalled: once it dies its children are re-parented and the link is lost.
 */
export function descendantPids(pid: number, snap: Map<number, { ppid: number; start: string }> | null = psSnapshot()): Array<{ pid: number; start: string }> {
  if (!snap) return [];
  const kids = new Map<number, number[]>();
  for (const [c, { ppid }] of snap) {
    const list = kids.get(ppid) ?? [];
    list.push(c);
    kids.set(ppid, list);
  }
  const out: Array<{ pid: number; start: string }> = [];
  const seen = new Set<number>();
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push({ pid: c, start: snap.get(c)!.start });
    stack.push(...(kids.get(c) ?? []));
  }
  return out;
}

/** After the child has exited, wait at most this long for its pipes to close (a descendant may hold them). */
const CLOSE_AFTER_EXIT_MS = 5_000;

export function realExec(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number; onPid?: (pid: number) => void; signal?: AbortSignal; isolatedGroup?: boolean },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) { resolve({ status: null, signal: null, stdout: '', stderr: '', deadlineKilled: false, aborted: true, pid: null }); return; }
    // Keep preflight children in the verifier's own detached group. The service's
    // cancellation and boot orphan sweep must reach them even if this process dies.
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid && opts.onPid) opts.onPid(child.pid);
    let stdout = '';
    let stderr = '';
    let deadlineKilled = false;
    let aborted = false;
    let settled = false;
    let exited = false;
    let quiescent = !opts.isolatedGroup;
    child.stdout?.on('data', (d) => { stdout = tail(stdout + d.toString()); });
    child.stderr?.on('data', (d) => { stderr = tail(stderr + d.toString()); });
    let hard: NodeJS.Timeout | undefined;
    let closeWait: NodeJS.Timeout | undefined;
    const signalTree = (pids: number[], sig: NodeJS.Signals) => {
      for (const p of pids) { try { process.kill(p, sig); } catch { /* @silent-fallback-ok: already gone */ } }
    };
    // runVerifyMain is the leader of its service-created process group. A failed
    // `ps` or a non-leader caller is unknown, never permission to start full lanes.
    const groupMembers = (): number[] | null => {
      if (!opts.isolatedGroup) return [];
      try {
        const output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf-8', timeout: 5_000 });
        const rows = output.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)).filter((m): m is RegExpMatchArray => !!m);
        if (!rows.some((m) => Number(m[1]) === process.pid && Number(m[3]) === process.pid)) return null;
        return rows.filter((m) => Number(m[3]) === process.pid && Number(m[1]) !== process.pid
          && !(Number(m[2]) === process.pid && path.basename(m[4]) === 'ps')).map((m) => Number(m[1]));
      } catch { return null; }
    };
    const groupAlive = () => { const members = groupMembers(); return members === null || members.length > 0; };
    const signalGroup = (sig: NodeJS.Signals) => {
      const members = groupMembers();
      if (members) signalTree(members, sig);
      else if (child.pid) signalTree([child.pid], sig);
    };
    // Stop the child AND its descendants (vitest workers, test subprocesses): a descendant that
    // survives the parent would otherwise hold the pipes open and the wait would never end.
    // The SIGKILL escalation is NOT cancelled when the process settles: closing the parent's
    // pipes says nothing about a descendant that ignored SIGTERM with its own stdio.
    // Once the process has exited its pid may be reused and its descendants are re-parented,
    // so nothing is signalled by pid then (the service's process-group sweep at the end of the
    // run still reaches them); only the bounded wait below applies.
    // The SIGKILL goes only to a pid whose start time is unchanged since the snapshot, so a pid
    // the system reused during the grace period is signalled only if the replacement also has the
    // same start second and command (not credible with sequential pid allocation).
    const stop = () => {
      if (exited || !child.pid) { armCloseWait(); return; }
      if (opts.isolatedGroup) {
        signalGroup('SIGTERM');
        hard = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
        hard.unref?.();
        return;
      }
      const before = descendantPids(child.pid);
      signalTree([child.pid, ...before.map((d) => d.pid)], 'SIGTERM');
      hard = setTimeout(() => {
        const now = psSnapshot();
        if (!now) { if (!exited) signalTree([child.pid!], 'SIGKILL'); return; }
        const same = (d: { pid: number; start: string }) => now.get(d.pid)?.start === d.start;
        const later = exited ? [] : descendantPids(child.pid!, now);
        signalTree([...(exited ? [] : [child.pid!]), ...before.filter(same).map((d) => d.pid), ...later.map((d) => d.pid)], 'SIGKILL');
      }, KILL_GRACE_MS);
      hard.unref?.();
    };
    // After a stop, once the process has exited, wait at most CLOSE_AFTER_EXIT_MS for its pipes.
    const armCloseWait = () => {
      if (closeWait || settled || !exited) return;
      closeWait = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(exitStatus, exitSignal);
      }, CLOSE_AFTER_EXIT_MS);
    };
    let exitStatus: number | null = null;
    let exitSignal: string | null = null;
    const timer = setTimeout(() => {
      if (aborted) return;
      deadlineKilled = true;
      stop();
    }, Math.max(1, opts.deadlineMs));
    // Stopped by the run (a sibling lane already failed): the same stop as a deadline.
    const onAbort = () => {
      if (deadlineKilled || aborted) return;
      aborted = true;
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (status: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeWait) clearTimeout(closeWait);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ status, signal, stdout, stderr, deadlineKilled, ...(aborted ? { aborted: true } : {}), pid: child.pid ?? null, ...(opts.isolatedGroup ? { quiescent } : {}) });
    };
    child.on('close', (status, signal) => {
      if (!opts.isolatedGroup) { done(status ?? null, signal ?? null); return; }
      // Closing the direct child's pipes does not prove its workers exited. The
      // verifier's own group is the service's cancellation scope and must be empty
      // (apart from this process) before admitting a full-suite lane.
      void (async () => {
        if (hard) clearTimeout(hard);
        if (groupAlive()) signalGroup('SIGTERM');
        const until = Date.now() + KILL_GRACE_MS;
        while (groupAlive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        if (groupAlive()) signalGroup('SIGKILL');
        const killUntil = Date.now() + CLOSE_AFTER_EXIT_MS;
        while (groupAlive() && Date.now() < killUntil) await new Promise((r) => setTimeout(r, 100));
        quiescent = !groupAlive();
        done(status ?? null, signal ?? null);
      })();
    });
    child.on('exit', (status, signal) => {
      exited = true;
      exitStatus = status ?? null;
      exitSignal = signal ?? null;
      if (aborted || deadlineKilled) armCloseWait();
    });
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
      size: (p) => { try { const st = fs.statSync(p); return st.isFile() ? st.size : null; } catch { return null; } }, // @silent-fallback-ok: absent or unreadable ⇒ no history
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

/** One already-running ordinary suite may finish before the verifier's lane phase. */
const SUITE_SLOT_ACQUIRE_MS = 45 * 60_000;

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
  const priorityKey = `local-verify-child:${process.pid}`;
  let lastRenewedAt = 0;
  const renewPriority = (): void => {
    if (Date.now() - lastRenewedAt < 30_000) return;
    try {
      sem.setMergeGatePriority(priorityKey, true);
      lastRenewedAt = Date.now();
    } catch (e) {
      log({ event: 'suite-priority-error', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  };
  renewPriority();
  try {
    const out = await sem.acquire({
      lane: 'suite', runClass: 'background', priority: 'merge-gate', budgetMs: SUITE_SLOT_ACQUIRE_MS,
      onWaitTick: renewPriority,
    });
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
  } finally {
    try { sem.setMergeGatePriority(priorityKey, false); } catch (e) {
      log({ event: 'suite-priority-error', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
}

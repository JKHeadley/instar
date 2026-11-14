/**
 * Real seams for LocalVerifyService (the server-side half). Everything here is
 * asynchronous or a constant-time syscall, so nothing blocks the server's event
 * loop: gh and ps run through async execFile; the run child is spawned detached
 * (its own process group) and unref'd.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getHostTestRunnerSemaphore, resolveCap } from '../core/hostTestRunnerSemaphore.js';
import type { ChildHandle, LocalVerifyServiceSeams, PrView } from './LocalVerifyService.js';
import { LaunchdNoFallbackError, launchdLabelPrefix, spawnViaLaunchd } from './launchdSpawn.js';

const execFileAsync = promisify(execFile);

/** Environment keys passed through to the run child; everything else is dropped. */
export const LOCAL_VERIFY_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'INSTAR_TEST_WORKERS',
]);

export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of LOCAL_VERIFY_ENV_ALLOWLIST) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** A full page means the list may be cut short, so it is not used as a complete list. */
const OPEN_PR_LIST_LIMIT = 1000;

export interface DefaultServiceSeamOpts {
  repo: string;
  /** Stable per-agent claim key; absent in isolated tests. */
  priorityKey?: string;
  /** The explicit per-agent GitHub environment (as MergeRunner uses); null = gh unavailable. */
  resolveGitHubEnv: () => NodeJS.ProcessEnv | null;
  /**
   * macOS: start each run child as its own launchd job with `ProcessType Interactive`, so the
   * run and its lanes use the performance cores instead of the efficiency cores every
   * session-descended process is kept on (see launchdSpawn.ts). Any failure before the run
   * starts falls back to the plain detached spawn. Ignored on other platforms.
   */
  performanceCores?: { stateDir: string; onFallback?: (reason: string) => void };
}

export function buildDefaultServiceSeams(opts: DefaultServiceSeamOpts): Omit<LocalVerifyServiceSeams, 'onStarved' | 'onRecord'> {
  const gh = async (args: string[]): Promise<string | null> => {
    const env = opts.resolveGitHubEnv();
    if (!env) return null;
    try {
      const { stdout } = await execFileAsync('gh', args, { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      return stdout;
    } catch {
      return null; // @silent-fallback-ok: an unreadable PR refuses the request (pr-unreadable)
    }
  };
  return {
    setSuitePriority(active: boolean): void {
      if (!opts.priorityKey) return;
      getHostTestRunnerSemaphore().setMergeGatePriority(opts.priorityKey, active);
    },
    async prView(pr: number): Promise<PrView | null> {
      // title/body/files feed the main-red repair match (mainRedHold.ts); gh lists the first 100 files.
      // labels: `merge-throughput` ranks the PR ahead of ordinary PRs (prPriority).
      const out = await gh(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'author,isCrossRepository,headRefName,headRefOid,baseRefName,baseRefOid,title,body,files,labels']);
      if (!out) return null;
      try {
        const v = JSON.parse(out) as PrView & { files?: unknown };
        const files = Array.isArray(v.files) ? (v.files as Array<{ path?: unknown }>).filter((f) => !!f && typeof f.path === 'string').map((f) => ({ path: f.path as string })) : null;
        const raw = v as { labels?: unknown };
        const labels = Array.isArray(raw.labels) ? (raw.labels as Array<{ name?: unknown }>).filter((l) => !!l && typeof l.name === 'string').map((l) => ({ name: l.name as string })) : null;
        return { ...v, files, labels };
      } catch { return null; }
    },
    async baseHead(baseRefName: string): Promise<string | null> {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baseRefName)) return null;
      const out = await gh(['api', `repos/${opts.repo}/branches/${baseRefName}`, '--jq', '.commit.sha']);
      const sha = out?.trim() ?? '';
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
    async commitInfo(sha: string): Promise<{ subject: string; parents: string[]; files: Array<{ filename: string; patch?: string | null }> | null } | null> {
      if (!/^[0-9a-f]{40}$/.test(sha)) return null;
      const out = await gh(['api', `repos/${opts.repo}/commits/${sha}`, '--jq', '{subject: (.commit.message | split("\n")[0]), parents: [.parents[].sha], files: [(.files // [])[] | {filename, patch}]}']);
      if (!out) return null;
      try {
        const o = JSON.parse(out) as { subject?: unknown; parents?: unknown; files?: unknown };
        if (typeof o.subject !== 'string' || !Array.isArray(o.parents) || !o.parents.every((x) => typeof x === 'string')) return null;
        const files = Array.isArray(o.files) && o.files.every((x) => !!x && typeof (x as { filename?: unknown }).filename === 'string')
          ? (o.files as Array<{ filename: string; patch?: unknown }>).map((x) => ({ filename: x.filename, patch: typeof x.patch === 'string' ? x.patch : null }))
          : null;
        return { subject: o.subject, parents: o.parents as string[], files };
      } catch { return null; } // @silent-fallback-ok: unreadable ⇒ verify as usual
    },
    async isPrOpen(pr: number): Promise<boolean | null> {
      const out = await gh(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'state']);
      if (!out) return null;
      try { return (JSON.parse(out) as { state?: string }).state === 'OPEN'; } catch { return null; }
    },
    async listOpenPrs(): Promise<ReadonlySet<number> | null> {
      const out = await gh(['pr', 'list', '--repo', opts.repo, '--state', 'open', '--limit', String(OPEN_PR_LIST_LIMIT), '--json', 'number']);
      if (!out) return null;
      try {
        const rows = JSON.parse(out) as Array<{ number?: unknown }>;
        if (!Array.isArray(rows) || rows.length >= OPEN_PR_LIST_LIMIT) return null; // may be cut short
        const numbers = rows.map((row) => row.number);
        return numbers.every((n): n is number => typeof n === 'number') ? new Set(numbers) : null;
      } catch { return null; } // @silent-fallback-ok: the caller falls back to per-PR reads
    },
    spawnRun(a): ChildHandle {
      const pc = opts.performanceCores;
      if (pc && process.platform === 'darwin') {
        try {
          return spawnViaLaunchd(a, {
            dir: path.join(pc.stateDir, 'state', 'local-verify', 'launchd'),
            labelPrefix: launchdLabelPrefix(pc.stateDir),
            cwd: process.cwd(),
          });
        } catch (e) {
          if (e instanceof LaunchdNoFallbackError) throw e; // a launchd job may still be running: never start it twice
          pc.onFallback?.(e instanceof Error ? e.message : String(e)); // the plain spawn below still runs it
        }
      }
      const fd = fs.openSync(a.logFile, 'a', 0o600);
      const child = spawn(a.command, a.args, { env: a.env, detached: true, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      if (!child.pid) throw new Error('spawn produced no pid');
      child.unref();
      const exited = new Promise<{ status: number | null; signal: string | null }>((resolve) => {
        child.on('exit', (status, signal) => resolve({ status: status ?? null, signal: signal ?? null }));
        child.on('error', () => resolve({ status: null, signal: null }));
      });
      return { pid: child.pid, exited };
    },
    isGroupAlive(pgid: number): boolean {
      try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
    },
    isPidAlive(pid: number): boolean {
      // Dead only on ESRCH (no such process). Anything else, EPERM included, means it exists.
      try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
    },
    killGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
      try { process.kill(-pgid, signal); } catch { /* @silent-fallback-ok: already gone */ }
    },
    async readProcessArgs(pid: number): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 5_000 });
        return stdout.trim() || null;
      } catch {
        return null; // @silent-fallback-ok: unreadable identity keeps the record (orphan-reap-incomplete)
      }
    },
    foreignSuiteHolders(): Array<{ pid: number }> {
      try {
        return getHostTestRunnerSemaphore().status().liveHolders.map((h) => ({ pid: h.pid }));
      } catch {
        return []; // @silent-fallback-ok: the bound is watch-only; an unreadable holders file is no observation
      }
    },
    suiteCapacity(): number {
      try {
        const semaphore = getHostTestRunnerSemaphore();
        // The verifier child receives scrubbedEnv(), which drops the server's
        // per-process cap override. Its cap is the shared tuning-file value.
        // Reserve the next slot whenever either side sees a cap of one.
        const serverCap = semaphore.status().cap;
        const childCap = resolveCap('suite', scrubbedEnv(), semaphore.resolveContext().tuning.file).cap;
        return Math.min(serverCap, childCap);
      } catch { return 1; } // @silent-fallback-ok: unknown capacity keeps a runnable verifier's next-slot claim
    },
  };
}

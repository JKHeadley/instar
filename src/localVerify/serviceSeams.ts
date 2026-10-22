/**
 * Real seams for LocalVerifyService (the server-side half). Everything here is
 * asynchronous or a constant-time syscall, so nothing blocks the server's event
 * loop: gh and ps run through async execFile; the run child is spawned detached
 * (its own process group) and unref'd.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { getHostTestRunnerSemaphore } from '../core/hostTestRunnerSemaphore.js';
import type { ChildHandle, LocalVerifyServiceSeams, PrView } from './LocalVerifyService.js';

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

export interface DefaultServiceSeamOpts {
  repo: string;
  /** The explicit per-agent GitHub environment (as MergeRunner uses); null = gh unavailable. */
  resolveGitHubEnv: () => NodeJS.ProcessEnv | null;
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
    async prView(pr: number): Promise<PrView | null> {
      const out = await gh(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'author,isCrossRepository,headRefName,headRefOid,baseRefName,baseRefOid']);
      if (!out) return null;
      try { return JSON.parse(out) as PrView; } catch { return null; }
    },
    async baseHead(baseRefName: string): Promise<string | null> {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baseRefName)) return null;
      const out = await gh(['api', `repos/${opts.repo}/branches/${baseRefName}`, '--jq', '.commit.sha']);
      const sha = out?.trim() ?? '';
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
    async isPrOpen(pr: number): Promise<boolean | null> {
      const out = await gh(['pr', 'view', String(pr), '--repo', opts.repo, '--json', 'state']);
      if (!out) return null;
      try { return (JSON.parse(out) as { state?: string }).state === 'OPEN'; } catch { return null; }
    },
    spawnRun(a): ChildHandle {
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
  };
}

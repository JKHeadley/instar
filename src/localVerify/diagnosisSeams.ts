/** Real peer-diagnosis seams. The diagnosis child owns a detached process group. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getHostTestRunnerSemaphore } from '../core/hostTestRunnerSemaphore.js';
import { realSeams } from './orchestratorSeams.js';
import type { ExecResult } from './orchestrator.js';
import type { FailedFileDiagnosisSeams } from './runFailedFileDiagnosis.js';

const CLEANUP_GRACE_MS = 5_000;

/** A failed ps read is uncertainty, never proof that descendants are gone. */
export function parseDiagnosisGroupMembers(rows: string, leaderPid: number): number[] | null {
  const parsed = rows.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m);
  if (!parsed.some((m) => Number(m[1]) === leaderPid && Number(m[3]) === leaderPid)) return null;
  return parsed.filter((m) => Number(m[3]) === leaderPid && Number(m[1]) !== leaderPid
    && !(Number(m[2]) === leaderPid && path.basename(m[4]) === 'ps')).map((m) => Number(m[1]));
}

function membersOfOurGroup(): number[] | null {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8', timeout: 2_000 });
    return parseDiagnosisGroupMembers(rows, process.pid);
  } catch { return null; }
}

async function clearGroup(): Promise<{ quiescent: boolean; forced: boolean }> {
  let members = membersOfOurGroup();
  if (members === null) return { quiescent: false, forced: false };
  if (members.length === 0) return { quiescent: true, forced: false };
  // The leader (this process) remains alive throughout cleanup, so its group ID
  // cannot be recycled. Signal only the other members; a failed lookup stays unsafe.
  for (const pid of members) { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
  await new Promise((resolve) => setTimeout(resolve, CLEANUP_GRACE_MS));
  members = membersOfOurGroup();
  if (members === null) return { quiescent: false, forced: true };
  for (const pid of members) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  if (members.length > 0) await new Promise((resolve) => setTimeout(resolve, CLEANUP_GRACE_MS));
  const final = membersOfOurGroup();
  return { quiescent: final !== null && final.length === 0, forced: true };
}

export function realDiagnosisSeams(log: (event: Record<string, unknown>) => void, verifyRoot: string, attemptRoot: string, signal: AbortSignal): FailedFileDiagnosisSeams {
  const base = realSeams(log, verifyRoot);
  const attemptId = path.basename(attemptRoot);
  if (!/^[0-9a-f]{32}$/.test(attemptId)) throw new Error('invalid diagnosis attempt root');
  const shortTemps = path.join('/tmp', `lv-${attemptId}`);
  fs.mkdirSync(shortTemps, { mode: 0o700 });
  fs.writeFileSync(path.join(shortTemps, '.owner'), attemptId, { mode: 0o600 });
  return {
    ...base,
    fs: { ...base.fs, mkdtemp: (prefix) => fs.mkdtempSync(path.join(shortTemps,
      prefix === 'lv-diagnosis-tmux-' ? 't-' : 'd-')) },
    exec: async (command, args, opts): Promise<ExecResult & { quiescent: boolean }> => {
      const isVitest = command.endsWith('/vitest');
      const started = Date.now();
      let release: (() => void) | null = null;
      if (isVitest) {
        const sem = getHostTestRunnerSemaphore();
        let held: Awaited<ReturnType<typeof sem.acquire>>;
        try { held = await sem.acquire({ lane: 'targeted', runClass: 'background', fileCount: 1,
          budgetMs: Math.min(60_000, opts.deadlineMs) }); }
        catch { return { status: null, signal: null, pid: null, stdout: '', stderr: '', deadlineKilled: true, quiescent: true }; }
        // A fail-open capacity witness is appropriate for the primary test
        // runner, but this optional diagnosis must not consume unclaimed CPU.
        if (held.kind !== 'acquired') return { status: null, signal: null, pid: null,
          stdout: '', stderr: '', deadlineKilled: true, quiescent: true };
        release = () => sem.release(held.id);
      }
      try {
        const left = opts.deadlineMs - (Date.now() - started);
        if (left <= 0) return { status: null, signal: null, pid: null, stdout: '', stderr: '', deadlineKilled: true, quiescent: true };
        const r = await base.exec(command, args, { cwd: opts.cwd, env: opts.env, deadlineMs: left, signal });
        const cleanup = await clearGroup();
        return { ...r, quiescent: cleanup.quiescent, ...(cleanup.forced ? { aborted: true } : {}) };
      } finally { release?.(); }
    },
  };
}

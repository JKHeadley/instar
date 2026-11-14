/**
 * Disk Steward prune child (spec docs/specs/disk-steward.md §3.6–§3.7).
 *
 *   node dist/monitoring/diskStewardMain.js --run-id <hex> --input-json <json>
 *
 * Spawned detached by the server, which owns the deadline and kills this
 * process group when it passes. Runs the two cache categories under the
 * per-user caches lock, measures sizes and the worktree plan (read-only), then
 * writes its own audit row and result file, so a run is recorded even if the
 * server restarts meanwhile. The input travels on argv, so a full disk cannot
 * stop the heal from starting.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pruneNpmCache, pruneDerivedData, realPruneSeams, type CategoryResult, type PruneSeams } from './diskSteward/pruneCategories.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { pruneContextArchive, CONTEXT_ARCHIVE_DEFAULT_MAX_GIB } from './diskSteward/pruneContextArchive.js';

export interface PruneChildInput {
  runId: string;
  agent: string;
  agentHome: string;
  trigger: 'auto' | 'manual';
  requestedBy?: { sessionId?: string; topicId?: number } | null;
  dryRun: boolean;
  npmCacheMaxGiB: number;
  /** Transcript archive limit (context-budget §9.7); absent ⇒ the default. */
  contextArchiveMaxGiB?: number;
  categoryBudgetMs: number;
  /** Measure sizes and the worktree plan (when a post is due and the cache is old). */
  measure: boolean;
  resultPath: string;
  auditPath: string;
}

export interface WorktreePlan {
  reclaimable: number;
  reclaimableBytes: number | null;
  kept: Record<string, number>;
  reaperArmed?: boolean;
}

export interface PruneChildResult {
  runId: string;
  startedAt: number;
  finishedAt: number;
  trigger: 'auto' | 'manual';
  dryRun: boolean;
  categories: CategoryResult[];
  bytesFreed: number;
  statfsBefore: number | null;
  statfsAfter: number | null;
  sizes?: { at: number; partial: boolean; folders: Array<{ name: string; bytes: number }> };
  worktrees?: WorktreePlan;
  verifyKept?: { count: number; bytes: number | null };
  cachesLock: 'held' | 'another-agent-running';
}

const LOCK_DIR = path.join(os.homedir(), '.instar', 'disk-steward');

/** Process start time as ps reports it (lstart), null when unknown. */
function startTimeOf(pid: number): string | null {
  try {
    // lint-allow-blocking-scan: runs in the prune child process, never on the server's event loop.
    // lint-allow-sync-spawn: prune child process only; the server never calls this.
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5_000 }).trim() || null;
  } catch {
    return null; // @silent-fallback-ok — unknown start ⇒ only the pid decides
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } // @silent-fallback-ok — EPERM means the pid exists; any other error means it does not
}

/**
 * The per-user caches lock (§3.6). An efficiency measure, not a safety one: two
 * overlapping cleans only repeat work. Stale when its holder (pid + start time)
 * is gone or its deadline passed.
 */
export function takeCachesLock(lockPath: string, me: { pid: number; startTime: string | null; agent: string; deadline: number }): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const body = JSON.stringify(me);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      let held: { pid?: number; startTime?: string | null; deadline?: number } = {};
      try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { held = {}; }
      const gone = typeof held.pid !== 'number' || !pidAlive(held.pid)
        || (held.startTime != null && startTimeOf(held.pid) !== held.startTime)
        || (typeof held.deadline === 'number' && Date.now() > held.deadline);
      if (!gone) return false;
      try { SafeFsExecutor.safeUnlinkSync(lockPath, { operation: 'src/monitoring/diskStewardMain.ts:stale-caches-lock' }); }
      catch { return false; } // @silent-fallback-ok — another agent took it first
    }
  }
  return false;
}

export function releaseCachesLock(lockPath: string, pid: number): void {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number };
    if (held.pid === pid) SafeFsExecutor.safeUnlinkSync(lockPath, { operation: 'src/monitoring/diskStewardMain.ts:release-caches-lock' });
  } catch { /* @silent-fallback-ok — already gone */ }
}

function statfsFree(p: string): number | null {
  try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { return null; } // @silent-fallback-ok — logged as null in the audit row
}

/** Top-level sizes of the agent home except `.worktrees` (§3.7). */
async function measureSizes(seams: PruneSeams, agentHome: string, budgetMs: number): Promise<PruneChildResult['sizes']> {
  const started = Date.now();
  const folders: Array<{ name: string; bytes: number }> = [];
  let partial = false;
  const names = (seams.readdir(agentHome) ?? []).filter((n) => n !== '.worktrees');
  // .instar holds the 2.0 lanes; size its children too so the post can name them.
  const targets = names.flatMap((n) => (n === '.instar' ? (seams.readdir(path.join(agentHome, n)) ?? []).map((c) => path.join(n, c)) : [n]));
  for (const rel of targets) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) { partial = true; break; }
    const bytes = await seams.sizeOf(path.join(agentHome, rel), Math.max(1_000, left));
    if (bytes === null) { partial = true; continue; }
    folders.push({ name: rel, bytes });
  }
  folders.sort((a, b) => b.bytes - a.bytes);
  return { at: Date.now(), partial, folders: folders.slice(0, 10) };
}

async function measureWorktrees(seams: PruneSeams, agentHome: string, budgetMs: number): Promise<WorktreePlan | undefined> {
  try {
    const { AgentWorktreeReaper } = await import('./AgentWorktreeReaper.js');
    const { makeAgentWorktreeReaperDeps } = await import('./agentWorktreeGit.js');
    // Read-only view: the child has no path to removing a worktree.
    const deps = {
      ...makeAgentWorktreeReaperDeps({ instarRepo: agentHome, worktreesDir: path.join(agentHome, '.worktrees') }),
      removeWorktree: (): void => { throw new Error('disk-steward child: worktree removal is not available here'); },
    };
    // Read-only: dryRun, and evaluate() never removes.
    const reaper = new AgentWorktreeReaper(deps, { enabled: false, dryRun: true });
    await reaper.prepare();
    const enumeration = deps.listWorktrees();
    if (!enumeration.ok) return undefined;
    const kept: Record<string, number> = {};
    let reclaimable = 0;
    let reclaimableBytes: number | null = 0;
    const started = Date.now();
    for (const w of enumeration.worktrees) {
      const e = reaper.evaluate(w);
      if (e.verdict === 'reap-eligible') {
        reclaimable++;
        const left = budgetMs - (Date.now() - started);
        const b = left > 0 ? await seams.sizeOf(w.path, Math.max(1_000, Math.min(left, 60_000))) : null;
        reclaimableBytes = b === null || reclaimableBytes === null ? null : reclaimableBytes + b;
      } else {
        kept[e.reason] = (kept[e.reason] ?? 0) + 1;
      }
    }
    return { reclaimable, reclaimableBytes, kept };
  } catch {
    return undefined; // @silent-fallback-ok — no plan line in the post; the audit row carries the absence
  }
}

export async function runPruneChild(input: PruneChildInput, seams: PruneSeams = realPruneSeams()): Promise<PruneChildResult> {
  const startedAt = Date.now();
  const agentHomeDev = seams.devOf(input.agentHome);
  const statfsBefore = statfsFree(input.agentHome);
  const lockPath = path.join(LOCK_DIR, 'caches.lock');
  const deadline = startedAt + 2 * input.categoryBudgetMs + 10 * 60_000;
  const got = takeCachesLock(lockPath, { pid: process.pid, startTime: startTimeOf(process.pid), agent: input.agent, deadline });
  const categories: CategoryResult[] = [];
  try {
    if (got) {
      categories.push(await pruneNpmCache(seams, { dryRun: input.dryRun, maxGiB: input.npmCacheMaxGiB, budgetMs: input.categoryBudgetMs, agentHomeDev }));
      categories.push(await pruneDerivedData(seams, { dryRun: input.dryRun, budgetMs: input.categoryBudgetMs, agentHomeDev }));
    } else {
      for (const c of ['npm-cache', 'derived-data'] as const) {
        categories.push({ category: c, plannedBytes: 0, plannedItems: 0, removedItems: 0, bytesFreed: 0, skipped: 'another-agent-running' });
      }
    }
  } finally {
    if (got) releaseCachesLock(lockPath, process.pid);
  }
  // The transcript archive is this agent's own state (no shared lock): over its
  // limit, oldest-superseded spans outside the current phase are evicted.
  try {
    categories.push(pruneContextArchive({
      stateDir: path.join(input.agentHome, '.instar'), dryRun: input.dryRun,
      maxGiB: input.contextArchiveMaxGiB ?? CONTEXT_ARCHIVE_DEFAULT_MAX_GIB, budgetMs: input.categoryBudgetMs,
    }));
  } catch (e) {
    categories.push({ category: 'context-archive', plannedBytes: 0, plannedItems: 0, removedItems: 0, bytesFreed: 0, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
  }
  const result: PruneChildResult = {
    runId: input.runId, startedAt, finishedAt: 0, trigger: input.trigger, dryRun: input.dryRun, categories,
    bytesFreed: categories.reduce((a, c) => a + c.bytesFreed, 0),
    statfsBefore, statfsAfter: statfsFree(input.agentHome),
    cachesLock: got ? 'held' : 'another-agent-running',
  };
  if (input.measure) {
    result.sizes = await measureSizes(seams, input.agentHome, input.categoryBudgetMs);
    result.worktrees = await measureWorktrees(seams, input.agentHome, input.categoryBudgetMs);
  }
  result.finishedAt = Date.now();
  return result;
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function parseArgs(argv: readonly string[]): { runId: string; input: PruneChildInput } | null {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const runId = get('--run-id');
  const json = get('--input-json');
  if (!runId || !/^[0-9a-f]{16,64}$/.test(runId) || !json) return null;
  try {
    const input = JSON.parse(json) as PruneChildInput;
    if (input.runId !== runId || typeof input.agentHome !== 'string' || typeof input.resultPath !== 'string') return null;
    return { runId, input };
  } catch { return null; }
}

const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; } // @silent-fallback-ok — not this module
})();

if (isMain) {
  void (async () => {
    const parsed = parseArgs(process.argv);
    if (!parsed) { process.exitCode = 2; return; }
    const { input } = parsed;
    // Backstop deadline of its own (the server normally kills the group first):
    // if the server could not record this run (a full disk), it still ends.
    const ownDeadlineMs = 2 * input.categoryBudgetMs + 15 * 60_000;
    setTimeout(() => process.exit(4), ownDeadlineMs).unref();
    let result: PruneChildResult | { runId: string; crash: string };
    try { result = await runPruneChild(input); }
    catch (e) { result = { runId: input.runId, crash: (e instanceof Error ? e.message : String(e)).slice(0, 500) }; }
    try {
      fs.mkdirSync(path.dirname(input.auditPath), { recursive: true });
      fs.appendFileSync(input.auditPath, JSON.stringify({ at: new Date().toISOString(), event: 'prune-run', agent: input.agent, requestedBy: input.requestedBy ?? null, ...result }) + '\n');
    } catch { /* @silent-fallback-ok — a full disk may refuse the audit row; the result file is tried next */ }
    try { writeAtomic(input.resultPath, JSON.stringify(result)); }
    catch { process.exitCode = 3; } // @silent-fallback-ok — the server sees no result and records the run as unrecorded
  })();
}

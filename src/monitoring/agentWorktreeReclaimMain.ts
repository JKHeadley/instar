/**
 * Agent worktree reclaim child (spec docs/specs/reaper-removal-out-of-process.md §1-4).
 *
 *   node dist/monitoring/agentWorktreeReclaimMain.js --run-id <hex> --input-json <json>
 *
 * Started by the server (agentWorktreeReclaimRunner.ts) `nice -n 10`, detached
 * in its own process group, with its working folder pinned to the agent home,
 * only when removal is live (`dryRun: false`). One run, in this order:
 *   1. an exclusive lock (temp file + `link(2)`, never empty, corroborated);
 *   2. leftover trash, one folder at a time, within a 300 s budget, with retry
 *      counts kept in a file (skipped after 3 failures, reported `trash-stuck`);
 *   3. a fresh evaluation (link index + one GitHub lookup), written to the
 *      report file the route serves;
 *   4. per eligible path, while the cap, the time-left rule and the on-disk
 *      config allow: `attempt` row → race re-check → other-repo check → PR 3480's
 *      archive + final re-check → git's lock → `renaming` row → rename into
 *      `<worktreesDir>/.trash/<attemptId>` → `renamed` row → `git worktree prune`
 *      → trash delete in a sub-process → outcome row.
 * Every row is appended and fsynced. A kill at any point leaves either the
 * checkout untouched at its path or a folder in `.trash/` only.
 *
 * A checkout with a real root `node_modules` (spec
 * docs/specs/reaper-node-modules-regenerable.md) is proven first by this run's
 * own evaluation (the reference comparison, memoized per pass). Its removal adds:
 * the residue archive into the content-addressed store (digest in the `archived`
 * row), a full-tree re-stat against the hash-time signature, a fresh root-link
 * check and deep-link re-read, fresh process scans, the signature saved durably
 * with the attempt, and AFTER the rename a second re-stat of the tree in trash:
 * a pass writes a fsynced `verified` row before prune and delete; a difference
 * renames the folder back (`kept … changed-during-removal`) or, when the original
 * path is taken, holds it (`trash-held`, never deleted automatically). Recovery
 * deletes such a trash folder only once its attempt has `verified`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor, type SubprocessRmResult, type WorktreeTrashScope } from '../core/SafeFsExecutor.js';
import {
  AgentWorktreeReaper,
  type AgentWorktreeReaperDeps,
  type ReclaimReportFile,
  type WorktreeEvaluation,
  type WorktreeInfo,
} from './AgentWorktreeReaper.js';
import {
  makeAgentWorktreeReaperDeps,
  apparentBytes,
  WORKTREE_TRASH_DIRNAME,
  type AgentWorktreeReclaimOps,
} from './agentWorktreeGit.js';
import {
  NodeModulesMemo,
  runNodeModulesPass,
  restatNodeModules,
  readNpmMajor,
  allocatedBytes,
  volumeOf,
  writeFileDurable,
  type HashSeams,
  type NodeModulesPassSummary,
  type StatSignature,
} from './agentWorktreeNodeModules.js';

const execFileAsync = promisify(execFile);
const OP = 'src/monitoring/agentWorktreeReclaimMain.ts';

export interface ReclaimChildInput {
  runId: string;
  agentHome: string;
  /** The agent home's own repository (prune runs with `-C <projectDir>`). */
  projectDir: string;
  worktreesDir: string;
  /** The runner's state folder: lock, trash retry counts, run rows. */
  stateDir: string;
  /** The agent's config file, re-read before each removal and each trash delete. */
  configPath: string;
  /** Append-only, fsynced rows for this run (the server wrote `intent` first). */
  rowsPath: string;
  /** The full evaluation the route serves. */
  reportPath: string;
  /** The server's kill deadline (epoch ms). */
  deadlineAt: number;
  maxReaps: number;
  githubMergeCheck: boolean;
  /** Paths whose breaker is open: never acted on. */
  excludedPaths: string[];
  /** No removal starts with less than this left before the deadline (5 × the measured 3 s). */
  minTimeLeftMs?: number;
  /** Leftover-trash cleanup budget per run. */
  trashBudgetMs?: number;
  /** A trash folder is skipped (reported `trash-stuck`) after this many failed deletes. */
  trashMaxFailures?: number;
  /** Back-off before retrying a failed trash delete: this × 2^(failures-1). */
  trashRetryBackoffMs?: number;
  /** A removal of a checkout with a real root node_modules starts only with this much left (5 × the measured 14 s). */
  minTimeLeftNodeModulesMs?: number;
  gateRecordArchiveDir?: string;
  /**
   * The root node_modules proof's state folder (manifests, memo). Absent ⇒ a real
   * root node_modules stays `work`, exactly as before (spec reaper-node-modules-regenerable).
   */
  nodeModulesStateDir?: string;
  /** The npm the reference builder uses (its major is part of the key). */
  npmPath?: string;
}

export const RECLAIM_DEFAULTS = {
  minTimeLeftMs: 15_000,
  minTimeLeftNodeModulesMs: 70_000,
  trashBudgetMs: 300_000,
  trashMaxFailures: 3,
  trashRetryBackoffMs: 3_600_000,
} as const;

/** One durable row. `t` names the step; the rest depends on it. */
export interface ReclaimRow {
  t: 'intent' | 'lock-busy' | 'lock' | 'trash-start' | 'trash-done' | 'trash-error' | 'trash-stuck' | 'trash-held'
    | 'attempt' | 'archived' | 'renaming' | 'renamed' | 'verified' | 'restored' | 'removed' | 'kept' | 'error' | 'stop' | 'done';
  at: number;
  runId?: string;
  attemptId?: string;
  path?: string;
  trash?: string;
  name?: string;
  reason?: string;
  manifestSha256?: string;
  [extra: string]: unknown;
}

export interface TrashRetryEntry { failures: number; lastAt: number; lastError: string }

export interface ReclaimChildResult {
  runId: string;
  outcome: 'ran' | 'lock-busy' | 'stopped-config';
  removed: string[];
  kept: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; reason: string }>;
  trash: { deleted: string[]; errors: Array<{ name: string; reason: string }>; stuck: Array<{ name: string; bytes: number | null; lastError: string }>; deferred: string[]; held?: Array<{ name: string; reason: string }> };
  stopReason: string | null;
}

/** Test seams. Production uses the real ones. */
export interface ReclaimChildSeams {
  deps?: AgentWorktreeReaperDeps & AgentWorktreeReclaimOps;
  now?: () => number;
  rmTree?: (target: string, opts: { worktreeTrashScope: WorktreeTrashScope; timeoutMs: number }) => Promise<SubprocessRmResult>;
  /** Command line of a pid, '' when gone, null when unreadable (lock corroboration). */
  commandOf?: (pid: number) => Promise<string | null>;
  /** Called after each row is written (tests use it to simulate a kill at a step). */
  afterRow?: (row: ReclaimRow) => void;
  /** The per-pass node_modules memo (tests pass the same one to their deps). */
  nodeModulesMemo?: NodeModulesMemo;
  /** npm's major version (tests); production reads `npm --version`. */
  npmMajor?: string | null;
  hashSeams?: HashSeams;
  /** Free/total bytes on a volume (tests). */
  volume?: (d: string) => { free: number; total: number } | null;
}

// ── Durable rows ────────────────────────────────────────────────────

/** Append one JSON row and fsync it. Throws when it cannot be made durable. */
export function appendDurableRow(file: string, row: ReclaimRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    const line = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
    let off = 0;
    while (off < line.length) off += fs.writeSync(fd, line, off, line.length - off);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Parse a rows file. A torn (unparseable) line is ignored. */
export function parseRows(raw: string): ReclaimRow[] {
  const out: ReclaimRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ReclaimRow;
      if (r && typeof r === 'object' && typeof r.t === 'string') out.push(r);
    } catch { /* @silent-fallback-ok — a torn last line (a kill mid-write) is ignored by design */ }
  }
  return out;
}

// ── Lock ────────────────────────────────────────────────────────────

interface LockBody { pid: number; runId: string; startedAt: number }

const defaultCommandOf = async (pid: number): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
    return stdout.trim();
  } catch (err) {
    // ps exits 1 when the pid is gone: that is a known answer, not an unreadable one.
    const e = err as { code?: unknown; stdout?: unknown };
    if (e.code === 1 && typeof e.stdout === 'string' && e.stdout.trim() === '') return '';
    return null; // @silent-fallback-ok — unreadable ⇒ the lock is not proven stale ⇒ kept
  }
};

/**
 * Take the run lock: write `{pid, runId, startedAt}` to a temp file, fsync, then
 * `link(2)` it to the lock path, so a lock can never exist empty. When the lock
 * exists it is stale (and cleared) only when its pid is gone or that pid's
 * command line does not contain the lock's run id (a reboot can reuse a pid). A
 * lock that cannot be read is stale only once older than `staleUnreadableMs`.
 */
export async function takeReclaimLock(
  lockPath: string,
  me: LockBody,
  opts: { staleUnreadableMs: number; now: () => number; commandOf: (pid: number) => Promise<string | null> },
): Promise<boolean> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const tmp = `${lockPath}.${me.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(me));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(tmp, lockPath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      if (!(await lockIsStale(lockPath, opts))) return false;
      try { SafeFsExecutor.safeUnlinkSync(lockPath, { operation: `${OP}:stale-lock` }); }
      catch { return false; } // @silent-fallback-ok — another run took or cleared it first
    }
    return false;
  } finally {
    try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: `${OP}:lock-temp` }); }
    catch { /* @silent-fallback-ok — a stray temp file never reads as the lock */ }
  }
}

async function lockIsStale(lockPath: string, opts: { staleUnreadableMs: number; now: () => number; commandOf: (pid: number) => Promise<string | null> }): Promise<boolean> {
  let held: Partial<LockBody> | null = null;
  try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockBody>; }
  catch { held = null; } // @silent-fallback-ok — decided by age below
  if (!held || typeof held.pid !== 'number' || typeof held.runId !== 'string' || !held.runId) {
    try { return opts.now() - fs.statSync(lockPath).mtimeMs > opts.staleUnreadableMs; }
    catch { return false; } // @silent-fallback-ok — vanished or unreadable ⇒ not cleared here
  }
  const cmd = await opts.commandOf(held.pid);
  if (cmd === null) return false; // unknown ⇒ never cleared
  return cmd === '' || !cmd.includes(held.runId);
}

export function releaseReclaimLock(lockPath: string, runId: string): void {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockBody>;
    if (held.runId === runId) SafeFsExecutor.safeUnlinkSync(lockPath, { operation: `${OP}:release-lock` });
  } catch { /* @silent-fallback-ok — already gone */ }
}

// ── Config re-read ──────────────────────────────────────────────────

/** True only while the on-disk config still says removal is live. Unreadable ⇒ false (stop). */
export function removalStillLive(configPath: string): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { monitoring?: { agentWorktreeReaper?: { enabled?: unknown; dryRun?: unknown } } };
    const r = cfg.monitoring?.agentWorktreeReaper;
    return r?.enabled === true && r?.dryRun === false;
  } catch {
    return false; // @silent-fallback-ok — cannot confirm live ⇒ stop, the safe direction
  }
}

// ── Trash retry counts ──────────────────────────────────────────────

export function readTrashRetries(file: string): Record<string, TrashRetryEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, TrashRetryEntry> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const e = v as Partial<TrashRetryEntry>;
      if (e && typeof e.failures === 'number' && typeof e.lastAt === 'number') out[k] = { failures: e.failures, lastAt: e.lastAt, lastError: String(e.lastError ?? '') };
    }
    return out;
  } catch {
    return {}; // @silent-fallback-ok — absent file ⇒ no failures yet
  }
}

function writeTrashRetries(file: string, retries: Record<string, TrashRetryEntry>): void {
  SafeFsExecutor.atomicWriteJsonSync(file, retries, { operation: `${OP}:trash-retries`, mode: 0o600 });
}

// ── The run ─────────────────────────────────────────────────────────

const ATTEMPT_ID = /^[0-9a-f]{8,64}-[0-9a-f]{6,16}$/;

export async function runReclaimChild(input: ReclaimChildInput, seams: ReclaimChildSeams = {}): Promise<ReclaimChildResult> {
  const now = seams.now ?? (() => Date.now());
  const minTimeLeftMs = input.minTimeLeftMs ?? RECLAIM_DEFAULTS.minTimeLeftMs;
  const trashBudgetMs = input.trashBudgetMs ?? RECLAIM_DEFAULTS.trashBudgetMs;
  const trashMaxFailures = input.trashMaxFailures ?? RECLAIM_DEFAULTS.trashMaxFailures;
  const trashBackoffMs = input.trashRetryBackoffMs ?? RECLAIM_DEFAULTS.trashRetryBackoffMs;
  const rmTree = seams.rmTree ?? ((t, o) => SafeFsExecutor.safeRmTreeInSubprocess(t, { operation: `${OP}:trash-delete`, ...o }));
  const trashRoot = path.join(input.worktreesDir, WORKTREE_TRASH_DIRNAME);
  const retriesPath = path.join(input.stateDir, 'trash-retries.json');
  const lockPath = path.join(input.stateDir, 'reclaim.lock');
  const result: ReclaimChildResult = {
    runId: input.runId, outcome: 'ran', removed: [], kept: [], errors: [],
    trash: { deleted: [], errors: [], stuck: [], deferred: [] }, stopReason: null,
  };
  const row = (r: Omit<ReclaimRow, 'at' | 'runId'>): void => {
    const full = { ...r, at: now(), runId: input.runId } as ReclaimRow;
    appendDurableRow(input.rowsPath, full);
    seams.afterRow?.(full);
  };

  const got = await takeReclaimLock(lockPath, { pid: process.pid, runId: input.runId, startedAt: now() }, {
    staleUnreadableMs: Math.max(900_000, input.deadlineAt - now()), now, commandOf: seams.commandOf ?? defaultCommandOf,
  });
  if (!got) {
    row({ t: 'lock-busy' });
    result.outcome = 'lock-busy';
    return result;
  }
  try {
    row({ t: 'lock' });
    const ensureTrashRoot = (): void => {
      try {
        const st = fs.lstatSync(trashRoot);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the trash root is not a real folder');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        fs.mkdirSync(trashRoot, { mode: 0o700 });
      }
    };
    const baseScope = (): WorktreeTrashScope => ({ worktreesDir: input.worktreesDir, trashRoot });
    /**
     * Rename a changed tree back to its exact recorded path when it is free, else hold
     * it. Never deletes. Returns 'restored' or 'held'.
     */
    const restoreOrHold = (name: string, trashPath: string, original: string, attemptId: string, why: string): 'restored' | 'held' => {
      if (!fs.existsSync(original) && !isSymlinkAt(original)) {
        try {
          SafeFsExecutor.safeRestoreDirSync(trashPath, original, { operation: `${OP}:restore-from-trash`, worktreeTrashScope: { ...baseScope(), restoreTo: original } });
          row({ t: 'restored', attemptId, path: original, reason: why });
          return 'restored';
        } catch (err) {
          hold(name, `restore failed: ${(err as Error).message.slice(0, 200)}`, attemptId);
          return 'held';
        }
      }
      hold(name, `${why}; the original path is taken`, attemptId);
      return 'held';
    };
    /** Recovery of a renamed-but-unverified node_modules attempt (§5): re-stat, then verify, restore or hold. */
    const recoverUnverified = (name: string, full: string, att: AttemptInfo): 'verified' | 'restored' | 'held' => {
      let sig: StatSignature | null = null;
      try { sig = att.signatureFile ? (JSON.parse(fs.readFileSync(att.signatureFile, 'utf8')) as { signature: StatSignature }).signature : null; }
      catch { sig = null; } // @silent-fallback-ok — no saved signature ⇒ cannot verify ⇒ held below
      if (!sig) { hold(name, 'renamed without verification and no saved signature', name); return 'held'; }
      const diff = restatNodeModules(full, sig);
      if (diff === null) { row({ t: 'verified', attemptId: name, recovered: true }); return 'verified'; }
      return att.path ? restoreOrHold(name, full, att.path, name, `changed-during-removal (${diff.slice(0, 120)})`) : (hold(name, 'changed and no recorded original path', name), 'held');
    };

    // ── 1. Leftover trash first, bounded ───────────────────────────
    const retries = readTrashRetries(retriesPath);
    const attemptIndex = readAttemptIndex(path.dirname(input.rowsPath));
    const knownAttempts = new Set(attemptIndex.keys());
    const held: Array<{ name: string; reason: string }> = [];
    result.trash.held = held;
    const hold = (name: string, reason: string, attemptId?: string): void => {
      held.push({ name, reason });
      row({ t: 'trash-held', name, reason, ...(attemptId ? { attemptId } : {}) });
    };
    let names: string[] = [];
    try { names = fs.readdirSync(trashRoot).sort(); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    const trashEnd = Math.min(now() + trashBudgetMs, input.deadlineAt - minTimeLeftMs);
    for (const name of names) {
      const full = path.join(trashRoot, name);
      // A checkout with a real node_modules: its trash is deleted only once its
      // attempt has `verified` (spec reaper-node-modules-regenerable §5). Held
      // folders are never deleted automatically.
      const att = attemptIndex.get(name);
      if (att?.held) { held.push({ name, reason: att.heldReason ?? 'held' }); continue; }
      if (att?.realNodeModules && !att.verified) {
        const outcome = recoverUnverified(name, full, att);
        if (outcome !== 'verified') continue;
      } else if (!att && isRealDirAt(path.join(full, 'node_modules'))) {
        // No rows survive for it: nothing proves its node_modules was verified.
        hold(name, 'no attempt rows and a real node_modules');
        continue;
      }
      const prior = retries[name];
      if (prior && prior.failures >= trashMaxFailures) {
        const bytes = apparentBytes(full);
        result.trash.stuck.push({ name, bytes, lastError: prior.lastError });
        row({ t: 'trash-stuck', name, bytes, failures: prior.failures, reason: prior.lastError });
        continue;
      }
      if (prior && now() < prior.lastAt + trashBackoffMs * 2 ** Math.max(0, prior.failures - 1)) { result.trash.deferred.push(name); continue; }
      if (now() >= trashEnd) { result.trash.deferred.push(name); continue; }
      if (!removalStillLive(input.configPath)) { result.stopReason = 'config-no-longer-live'; break; }
      row({ t: 'trash-start', name, knownAttempt: knownAttempts.has(name) });
      // Counted BEFORE the delete: a kill or a deadline cut-off mid-delete has already counted.
      retries[name] = { failures: (prior?.failures ?? 0) + 1, lastAt: now(), lastError: 'cut off before it finished' };
      writeTrashRetries(retriesPath, retries);
      let r: SubprocessRmResult;
      try { r = await rmTree(full, { worktreeTrashScope: baseScope(), timeoutMs: Math.max(1, trashEnd - now()) }); }
      catch (err) { r = { ok: false, exitCode: null, signal: null, timedOut: false, error: (err as Error).message }; }
      const gone = !fs.existsSync(full) && !isSymlinkAt(full);
      if (r.ok && gone) {
        delete retries[name];
        writeTrashRetries(retriesPath, retries);
        result.trash.deleted.push(name);
        row({ t: 'trash-done', name });
      } else {
        retries[name] = { ...retries[name], lastError: (r.error ?? 'folder still present after delete').slice(0, 300) };
        writeTrashRetries(retriesPath, retries);
        result.trash.errors.push({ name, reason: retries[name].lastError });
        row({ t: 'trash-error', name, reason: retries[name].lastError });
      }
    }
    if (result.stopReason) {
      result.outcome = 'stopped-config';
      row({ t: 'stop', reason: result.stopReason });
      return result;
    }

    // ── 2. Fresh evaluation ────────────────────────────────────────
    const nmMemo = seams.nodeModulesMemo ?? (input.nodeModulesStateDir ? new NodeModulesMemo(input.nodeModulesStateDir) : undefined);
    const madeDeps = seams.deps ? null : makeAgentWorktreeReaperDeps({
      instarRepo: input.projectDir,
      worktreesDir: input.worktreesDir,
      githubMergeCheck: input.githubMergeCheck,
      ...(input.gateRecordArchiveDir ? { gateRecordArchiveDir: input.gateRecordArchiveDir } : {}),
      ...(nmMemo ? { nodeModulesMemo: nmMemo } : {}),
    });
    const deps = seams.deps ?? madeDeps!;
    const reaper = new AgentWorktreeReaper(deps, { enabled: true, dryRun: false });
    await reaper.prepare();
    const enumeration = deps.listWorktrees();
    let nodeModulesSummary: NodeModulesPassSummary | null = null;
    const report = (phase: ReclaimReportFile['phase'], worktrees: WorktreeEvaluation[], ok: boolean, error: string | null): void => {
      const body: ReclaimReportFile = {
        runId: input.runId, at: now(), phase, enumerationOk: ok, enumerationError: error, worktrees,
        archiveBytes: reaper.measureArchive(), removed: [...result.removed], stopReason: result.stopReason,
        trash: result.trash,
        ...(nodeModulesSummary ? { nodeModules: nodeModulesSummary } : {}),
        linkIndex: deps.linkIndexStatus ? deps.linkIndexStatus() : 'ok',
      };
      SafeFsExecutor.atomicWriteJsonSync(input.reportPath, body, { operation: `${OP}:report`, mode: 0o600, indent: 0 });
    };
    if (!enumeration.ok) {
      result.stopReason = 'enumeration-failed';
      report('final', [], false, enumeration.error);
      row({ t: 'stop', reason: `enumeration failed: ${enumeration.error}`.slice(0, 300) });
      return result;
    }
    // The root node_modules verdicts for this pass (spec reaper-node-modules-regenerable §4):
    // computed once here, read by classifyIgnoredEntry through the memo.
    const archiveRoot = deps.gateRecordArchiveDir ?? input.gateRecordArchiveDir ?? path.join(input.agentHome, '.instar', 'instar-dev-decisions-archive');
    if (nmMemo && input.nodeModulesStateDir && deps.isCleanExceptRootNodeModules) {
      nodeModulesSummary = runNodeModulesPass({
        deps: { isInUse: deps.isInUse, isMerged: deps.isMerged, isCleanExceptRootNodeModules: deps.isCleanExceptRootNodeModules },
        worktrees: enumeration.worktrees, memo: nmMemo, refsDir: input.nodeModulesStateDir, archiveRoot,
        maxHashes: input.maxReaps, npmMajor: seams.npmMajor !== undefined ? seams.npmMajor : readNpmMajor(input.npmPath ?? 'npm', os.tmpdir()),
        passId: input.runId, now, ...(seams.volume ? { volume: seams.volume } : {}), ...(seams.hashSeams ? { hashSeams: seams.hashSeams } : {}),
      });
    }
    const excluded = new Set(input.excludedPaths);
    const evaluations: WorktreeEvaluation[] = [];
    const candidates: Array<{ info: WorktreeInfo; evaln: WorktreeEvaluation }> = [];
    for (const info of enumeration.worktrees) {
      let evaln: WorktreeEvaluation;
      try { evaln = reaper.annotate(reaper.evaluate(info), true); }
      catch { evaln = { path: info.path, branch: info.branch, verdict: 'keep', reason: 'eval-error' }; }
      if (evaln.verdict === 'reap-eligible' && excluded.has(info.path)) {
        evaln = { path: info.path, branch: info.branch, verdict: 'keep', reason: 'reclaim-failed' };
      }
      const nmCheck = nodeModulesSummary?.checks[info.path];
      if (nmCheck) evaln.nodeModulesCheck = nmCheck;
      evaluations.push(evaln);
      if (evaln.verdict === 'reap-eligible') { evaln.outcome = 'not-attempted'; candidates.push({ info, evaln }); }
    }
    report('evaluated', evaluations, true, null);

    // ── 3. Removals ────────────────────────────────────────────────
    const allowedSources = candidates.map((c) => c.info.path);
    const scope = (): WorktreeTrashScope => ({ ...baseScope(), allowedSources });
    const minTimeLeftNmMs = input.minTimeLeftNodeModulesMs ?? RECLAIM_DEFAULTS.minTimeLeftNodeModulesMs;
    for (const { info, evaln } of candidates) {
      if (result.removed.length >= input.maxReaps) { result.stopReason = 'cap'; break; }
      // Time left per kind (spec reaper-node-modules-regenerable §5): 5 × the measured time for this kind.
      // Decided from the disk too, not only the report field: a real root node_modules
      // must always go through the proof, re-checks and the `verified` row.
      const realNm = evaln.nodeModules === 'real' || (() => {
        try { const st = fs.lstatSync(path.join(info.path, 'node_modules')); return st.isDirectory() && !st.isSymbolicLink(); }
        catch { return false; } // @silent-fallback-ok — no node_modules ⇒ not the real-install path
      })();
      if (input.deadlineAt - now() < (realNm ? minTimeLeftNmMs : minTimeLeftMs)) {
        if (realNm && input.deadlineAt - now() >= minTimeLeftMs) { evaln.outcome = 'not-attempted'; evaln.outcomeReason = 'time-left'; continue; }
        result.stopReason = 'time-left'; break;
      }
      if (!removalStillLive(input.configPath)) { result.stopReason = 'config-no-longer-live'; break; }
      const attemptId = `${input.runId.slice(0, 16)}-${crypto.randomBytes(4).toString('hex')}`;
      if (!ATTEMPT_ID.test(attemptId)) throw new Error('internal: bad attempt id');
      const keep = (reason: string): void => {
        evaln.outcome = 'kept'; evaln.outcomeReason = reason;
        result.kept.push({ path: info.path, reason });
        row({ t: 'kept', attemptId, reason });
      };
      row({ t: 'attempt', attemptId, path: info.path, ...(realNm ? { realNodeModules: true } : {}) });
      try {
        // Re-evaluate immediately before acting: marker, branch, in use, clean, merged.
        const raced = reaper.reclaimRaceGuard(info);
        if (raced) { keep(raced); continue; }
        // Only the agent home's own repository: one prune against it is then enough.
        if (deps.isOtherRepo(info.path)) { keep('other-repo'); continue; }
        // A locked worktree is kept and reported (checked before the archive, and again after it).
        const lockBefore = deps.worktreeLockState(info.path);
        if (lockBefore !== 'unlocked') { keep(lockBefore === 'locked' ? 'locked' : 'lock-unknown'); continue; }
        // A real root node_modules must carry this pass's proof (memo) and its signature.
        const nmSig: StatSignature | null = realNm ? (nmMemo?.signatureFor(info.path) ?? null) : null;
        if (realNm && !nmSig) { keep('node-modules-unproven'); continue; }
        // PR 3480's archive + final re-check (fresh process scans). Throws ⇒ error row.
        // With a real node_modules this also archives its residue into the store, every
        // blob, manifest and folder fsynced; its digest goes in the archived row.
        const prep = deps.prepareRemovalDetailed ? deps.prepareRemovalDetailed(info.path) : { manifestSha256: deps.prepareRemoval(info.path) };
        if (realNm && !prep.nodeModules) { keep('node-modules-unproven'); continue; }
        row({ t: 'archived', attemptId, manifestSha256: prep.manifestSha256, ...(prep.nodeModules ? { nodeModulesResidueSha256: prep.nodeModules.manifestSha256, nodeModulesResidueManifest: prep.nodeModules.manifestPath, nodeModulesStoredBytes: prep.nodeModules.storedBytes } : {}) });
        // The closed-unmerged rule (§5) re-read with a fresh remote ref.
        if (!deps.isMergedFresh(info)) { keep('raced-now-unmerged'); continue; }
        const lock = deps.worktreeLockState(info.path);
        if (lock !== 'unlocked') { keep(lock === 'locked' ? 'locked' : 'lock-unknown'); continue; }
        let signatureFile: string | undefined;
        if (realNm && nmSig) {
          // §5: re-list and re-lstat every entry against the hash-time signature.
          const diff = restatNodeModules(info.path, nmSig);
          if (diff) { keep(`changed-since-hash: ${diff.slice(0, 200)}`); continue; }
          // §2: a fresh root-link check over every worktree git lists, the walk roots at
          // depth 1, and a re-read of every deep link the index found.
          const link = deps.freshLinkCheck ? await deps.freshLinkCheck(info.path) : null;
          if (link) { keep(`in-use-link: ${link.slice(0, 200)}`); continue; }
          // Then the fresh in-use scans, then the rename.
          if (deps.freshProcessCheck) deps.freshProcessCheck(info.path);
          signatureFile = path.join(input.stateDir, 'attempt-signatures', `${attemptId}.json`);
          writeFileDurable(signatureFile, JSON.stringify({ attemptId, path: info.path, signature: nmSig }));
        }
        ensureTrashRoot();
        const trash = path.join(trashRoot, attemptId);
        row({ t: 'renaming', attemptId, trash, ...(signatureFile ? { signatureFile } : {}) });
        SafeFsExecutor.safeRenameDirSync(info.path, trash, { operation: `${OP}:rename-to-trash`, worktreeTrashScope: scope() });
        row({ t: 'renamed', attemptId });
        if (realNm && nmSig) {
          // §5: once more, after the rename (nothing new can open a file at the old path),
          // before prune, so git's record is still intact for a rename back.
          const diff = restatNodeModules(trash, nmSig);
          if (diff) {
            const r = restoreOrHold(attemptId, trash, info.path, attemptId, 'changed-during-removal');
            keep(r === 'restored' ? 'changed-during-removal' : 'trash-held');
            continue;
          }
          row({ t: 'verified', attemptId });
        }
        let pruneError: string | null = null;
        try { deps.pruneWorktrees(); }
        catch (err) { pruneError = (err as Error).message.slice(0, 300); } // @silent-fallback-ok — recorded in the removed row; the next run's prune drops the entry
        let trashDeleted = false;
        let measured: { allocatedBytes: number | null; freeDeltaBytes: number | null } | null = null;
        if (removalStillLive(input.configPath)) {
          const vol = seams.volume ?? volumeOf;
          const before = vol(trashRoot)?.free ?? null;
          const allocated = allocatedBytes(trash);
          retries[attemptId] = { failures: 1, lastAt: now(), lastError: 'cut off before it finished' };
          writeTrashRetries(retriesPath, retries);
          let r: SubprocessRmResult;
          try { r = await rmTree(trash, { worktreeTrashScope: baseScope(), timeoutMs: Math.max(1, Math.min(trashBudgetMs, input.deadlineAt - now())) }); }
          catch (err) { r = { ok: false, exitCode: null, signal: null, timedOut: false, error: (err as Error).message }; }
          trashDeleted = r.ok && !fs.existsSync(trash);
          const after = vol(trashRoot)?.free ?? null;
          measured = { allocatedBytes: allocated, freeDeltaBytes: before !== null && after !== null ? after - before : null };
          if (trashDeleted) { delete retries[attemptId]; row({ t: 'trash-done', name: attemptId }); }
          else { retries[attemptId] = { ...retries[attemptId], lastError: (r.error ?? 'folder still present after delete').slice(0, 300) }; row({ t: 'trash-error', name: attemptId, reason: retries[attemptId].lastError }); }
          writeTrashRetries(retriesPath, retries);
        }
        result.removed.push(info.path);
        evaln.outcome = 'removed';
        // The free-space change is an estimate: other activity on the disk moves it too.
        row({ t: 'removed', attemptId, trashDeleted, ...(pruneError ? { pruneError } : {}), ...(measured ? { allocatedBytes: measured.allocatedBytes, freeDeltaBytes: measured.freeDeltaBytes, freeDeltaIsEstimate: true } : {}) });
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        evaln.outcome = 'error'; evaln.outcomeReason = reason;
        result.errors.push({ path: info.path, reason });
        row({ t: 'error', attemptId, reason });
      }
    }
    if (result.stopReason === 'config-no-longer-live') result.outcome = 'stopped-config';
    report('final', evaluations, true, null);
    row({ t: 'done', removed: result.removed.length, reason: result.stopReason ?? undefined });
    return result;
  } finally {
    releaseReclaimLock(lockPath, input.runId);
  }
}

function isSymlinkAt(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } // @silent-fallback-ok — absent
}

function isRealDirAt(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; } // @silent-fallback-ok — absent
}

/** What the rows say about one attempt, across every run (trash recovery reads it). */
export interface AttemptInfo {
  path?: string;
  realNodeModules: boolean;
  verified: boolean;
  held: boolean;
  heldReason?: string;
  signatureFile?: string;
}

/** Attempts named in any run's rows (to recover or report a trash folder). Bounded to the last 200 run files. */
export function readAttemptIndex(runsDir: string): Map<string, AttemptInfo> {
  const ids = new Map<string, AttemptInfo>();
  let files: string[] = [];
  try { files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-200); }
  catch { return ids; } // @silent-fallback-ok — no rows yet
  const get = (id: string): AttemptInfo => {
    let a = ids.get(id);
    if (!a) { a = { realNodeModules: false, verified: false, held: false }; ids.set(id, a); }
    return a;
  };
  for (const f of files) {
    let raw: string;
    try { raw = fs.readFileSync(path.join(runsDir, f), 'utf8'); } catch { continue; } // @silent-fallback-ok — unreadable rows: the folder is still cleaned and reported
    for (const r of parseRows(raw)) {
      const id = typeof r.attemptId === 'string' ? r.attemptId : (r.t === 'trash-held' && typeof r.name === 'string' ? r.name : null);
      if (!id) continue;
      if (r.t === 'attempt') { const a = get(id); if (typeof r.path === 'string') a.path = r.path; if (r.realNodeModules === true) a.realNodeModules = true; }
      else if (r.t === 'renaming' && typeof r.signatureFile === 'string') get(id).signatureFile = r.signatureFile;
      else if (r.t === 'verified') get(id).verified = true;
      else if (r.t === 'trash-held') { const a = get(id); a.held = true; a.heldReason = typeof r.reason === 'string' ? r.reason : 'held'; }
      else if (r.t === 'restored') { const a = get(id); a.held = false; }
    }
  }
  return ids;
}

// ── Entry ───────────────────────────────────────────────────────────

export function parseReclaimArgs(argv: readonly string[]): ReclaimChildInput | null {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const runId = get('--run-id');
  const json = get('--input-json');
  if (!runId || !/^[0-9a-f]{16,64}$/.test(runId) || !json) return null;
  try {
    const input = JSON.parse(json) as ReclaimChildInput;
    if (input.runId !== runId) return null;
    for (const k of ['agentHome', 'projectDir', 'worktreesDir', 'stateDir', 'configPath', 'rowsPath', 'reportPath'] as const) {
      if (typeof input[k] !== 'string' || !path.isAbsolute(input[k])) return null;
    }
    if (typeof input.deadlineAt !== 'number' || typeof input.maxReaps !== 'number' || !Array.isArray(input.excludedPaths)) return null;
    return input;
  } catch { return null; } // @silent-fallback-ok — malformed input ⇒ exit 2, nothing done
}

const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; } // @silent-fallback-ok — not this module
})();

if (isMain) {
  void (async () => {
    const input = parseReclaimArgs(process.argv);
    if (!input) { process.exitCode = 2; return; }
    // The executors write their audit trail to <cwd>/.instar/audit: it must be the
    // agent home, never a checkout (spec §1).
    let cwdOk = false;
    try { cwdOk = fs.realpathSync(process.cwd()) === fs.realpathSync(input.agentHome); } catch { cwdOk = false; } // @silent-fallback-ok — unresolvable ⇒ refuse to run
    if (!cwdOk) { process.exitCode = 5; return; }
    // Backstop of its own (the server normally ends the group first).
    setTimeout(() => process.exit(4), Math.max(60_000, input.deadlineAt - Date.now() + 60_000)).unref();
    try { await runReclaimChild(input); }
    catch (e) {
      try { appendDurableRow(input.rowsPath, { t: 'error', at: Date.now(), runId: input.runId, reason: `crash: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` }); }
      catch { /* @silent-fallback-ok — the server reconciles open attempts from the disk */ }
      process.exitCode = 3;
    }
  })();
}

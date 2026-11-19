/**
 * Server side of the agent worktree reclaim child (spec
 * docs/specs/reaper-removal-out-of-process.md §1-3). Built like the disk
 * steward's PruneRunner, with its own state folder and process name.
 *
 * - Intent first: `run.json` (state `intent`) and an `intent` row in the run's
 *   rows file are written durably BEFORE the spawn; if either write fails, no run
 *   is started.
 * - Ownership is held by the run's PROCESS GROUP, not only its leader: a run is
 *   finished only when no process in the group remains (asynchronous
 *   `ps -o pid=,pgid=,command= -g <pgid>`). A child that died while its `git` or
 *   `rm` sub-process kept running still holds exclusion.
 * - Corroboration: a member's command line contains the run id. Past the
 *   deadline a corroborated group is killed with escalation (SIGTERM, then
 *   SIGKILL). A group from before a reboot is treated as gone (pids reused).
 * - Adoption: after a restart, a recorded live, corroborated group is tracked
 *   again; an unreadable process list leaves ownership unresolved, and no new
 *   run starts until it is resolved.
 * - Every supervision scan is `execFile` (asynchronous), never a synchronous one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReclaimAttemptOutcome, ReclaimReportFile, ReclaimRunnerPort } from './AgentWorktreeReaper.js';
import { appendDurableRow, parseRows, type ReclaimChildInput, type ReclaimRow } from './agentWorktreeReclaimMain.js';
import { WORKTREE_TRASH_DIRNAME } from './agentWorktreeGit.js';

const execFileAsync = promisify(execFile);

export interface ReclaimRunRecord {
  runId: string;
  startedAt: number;
  deadline: number;
  rowsPath: string;
  state: 'intent' | 'spawned' | 'finished' | 'stale';
  pid?: number;
  pgid?: number;
  /** Outcomes of this run have been fed to the breaker. */
  consumed?: boolean;
  finishedAt?: number;
  finishReason?: string;
}

export interface ReclaimGroupMember { pid: number; command: string }

export interface ReclaimRunnerSeams {
  spawnChild(args: string[], cwd: string): { pid: number | undefined };
  /** Members of a process group ([] = none), null when the process list cannot be read. */
  groupMembers(pgid: number): Promise<ReclaimGroupMember[] | null>;
  /** pgid of a process whose command line contains both needles, null when none / unreadable. */
  findGroupByArgs(needles: string[]): Promise<number | null>;
  killGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Durable whole-file write (temp, fsync, rename). false on failure. */
  writeDurable(file: string, data: string): boolean;
  /** Durable row append (fsync). false on failure. */
  appendRow(file: string, row: ReclaimRow): boolean;
  readFile(file: string): Promise<string | null>;
  exists(file: string): Promise<boolean>;
  /** Epoch ms of the last boot. */
  bootTime(): number;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

export interface ReclaimRunnerConfig {
  stateDir: string;
  /** Matched in command lines for adoption (e.g. 'agentWorktreeReclaimMain'). */
  processName: string;
  mainScript: string;
  nodePath: string;
  agentHome: string;
  projectDir: string;
  worktreesDir: string;
  configPath: string;
  githubMergeCheck: () => boolean;
  maxReaps: () => number;
  /** Run deadline (spec §4: 300 s trash + 300 s link index + 300 s removals). */
  runDeadlineMs?: number;
  pollMs?: number;
  killGraceMs?: number;
  /** An uncorroborated surviving group stops holding exclusion this long past the deadline. */
  uncorroboratedReleaseMs?: number;
  gateRecordArchiveDir?: string;
  /** The root node_modules proof's state folder (spec reaper-node-modules-regenerable); absent ⇒ off. */
  nodeModulesStateDir?: string;
  npmPath?: string;
}

export const RECLAIM_RUN_DEADLINE_MS = 900_000;

export class AgentWorktreeReclaimRunner implements ReclaimRunnerPort {
  private current: { record: ReclaimRunRecord; done: Promise<void>; resolve: () => void; timers: Array<{ cancel(): void }>; killed: boolean } | null = null;
  /** A recorded run whose ownership could not be decided (process list unreadable). */
  private unresolved: ReclaimRunRecord | null = null;
  private recovered = false;

  constructor(private readonly cfg: ReclaimRunnerConfig, private readonly seams: ReclaimRunnerSeams = realReclaimRunnerSeams(cfg.nodePath)) {}

  get runFile(): string { return path.join(this.cfg.stateDir, 'run.json'); }
  get runsDir(): string { return path.join(this.cfg.stateDir, 'runs'); }
  get reportPath(): string { return path.join(this.cfg.stateDir, 'report.json'); }
  private get consumedFile(): string { return path.join(this.cfg.stateDir, 'consumed-attempts.json'); }

  busy(): boolean { return this.current !== null || this.unresolved !== null; }
  running(): ReclaimRunRecord | null { return this.current ? { ...this.current.record } : null; }

  /** Boot recovery (adoption). Safe to call more than once. */
  async recover(): Promise<'none' | 'finished' | 'adopted' | 'stale' | 'unresolved'> {
    this.recovered = true;
    if (this.current) return 'adopted';
    const raw = await this.seams.readFile(this.runFile);
    if (!raw) return 'none';
    let record: ReclaimRunRecord;
    try { record = JSON.parse(raw) as ReclaimRunRecord; } catch { return 'none'; } // @silent-fallback-ok — a torn run.json: rows still reconcile from disk
    if (record.state === 'finished' || record.state === 'stale') return 'finished';
    const verdict = await this.resolveOwnership(record);
    if (verdict === 'unknown') { this.unresolved = record; return 'unresolved'; }
    this.unresolved = null;
    if (verdict === 'gone') { this.markFinished(record, record.startedAt < this.seams.bootTime() ? 'stale' : 'finished', 'group gone at recovery'); return record.startedAt < this.seams.bootTime() ? 'stale' : 'finished'; }
    this.track(record);
    if (this.seams.now() >= record.deadline) await this.killIfCorroborated(record);
    return 'adopted';
  }

  /**
   * Whether the recorded run's group still owns the reclaim:
   * 'alive' — members exist (corroborated, or same boot and within the release bound);
   * 'gone' — no members, or the run predates the last boot, or uncorroborated past the release bound;
   * 'unknown' — the process list could not be read.
   */
  private async resolveOwnership(record: ReclaimRunRecord): Promise<'alive' | 'gone' | 'unknown'> {
    if (record.startedAt < this.seams.bootTime()) return 'gone'; // a reboot ended every process of that run
    let pgid = record.pgid;
    if (pgid === undefined) {
      pgid = (await this.seams.findGroupByArgs([record.runId, this.cfg.processName])) ?? undefined;
      if (pgid === undefined) return 'gone';
      record.pgid = pgid;
    }
    const members = await this.seams.groupMembers(pgid);
    if (members === null) return 'unknown';
    if (members.length === 0) return 'gone';
    if (members.some((m) => m.command.includes(record.runId))) return 'alive';
    // The leader died; a sub-process (git, rm) carries no run id. Same boot: still ours,
    // bounded so a pgid reused by an unrelated process cannot jam the reaper forever.
    const bound = record.deadline + (this.cfg.uncorroboratedReleaseMs ?? 3_600_000);
    return this.seams.now() > bound ? 'gone' : 'alive';
  }

  async startRun(req: { excludedPaths: string[] }): Promise<{ started: true; runId: string; done: Promise<void> } | { started: false; reason: string }> {
    if (!this.recovered) await this.recover();
    if (this.current) return { started: false, reason: 'busy' };
    if (this.unresolved) {
      const verdict = await this.resolveOwnership(this.unresolved);
      if (verdict === 'unknown') return { started: false, reason: 'unresolved' };
      if (verdict === 'alive') { this.track(this.unresolved); this.unresolved = null; return { started: false, reason: 'busy' }; }
      this.markFinished(this.unresolved, 'finished', 'group gone');
      this.unresolved = null;
    }
    const runId = crypto.randomBytes(16).toString('hex');
    const now = this.seams.now();
    const deadline = now + (this.cfg.runDeadlineMs ?? RECLAIM_RUN_DEADLINE_MS);
    const rowsPath = path.join(this.runsDir, `${runId}.jsonl`);
    const record: ReclaimRunRecord = { runId, startedAt: now, deadline, rowsPath, state: 'intent' };
    // Durable intent BEFORE the spawn: a failed write means no run.
    if (!this.seams.writeDurable(this.runFile, JSON.stringify(record))) return { started: false, reason: 'intent-failed' };
    if (!this.seams.appendRow(rowsPath, { t: 'intent', at: now, runId })) {
      this.markFinished(record, 'finished', 'intent row write failed');
      return { started: false, reason: 'intent-failed' };
    }
    const input: ReclaimChildInput = {
      runId, agentHome: this.cfg.agentHome, projectDir: this.cfg.projectDir, worktreesDir: this.cfg.worktreesDir,
      stateDir: this.cfg.stateDir, configPath: this.cfg.configPath, rowsPath, reportPath: this.reportPath,
      deadlineAt: deadline, maxReaps: this.cfg.maxReaps(), githubMergeCheck: this.cfg.githubMergeCheck(),
      excludedPaths: req.excludedPaths,
      ...(this.cfg.gateRecordArchiveDir ? { gateRecordArchiveDir: this.cfg.gateRecordArchiveDir } : {}),
      ...(this.cfg.nodeModulesStateDir ? { nodeModulesStateDir: this.cfg.nodeModulesStateDir } : {}),
      ...(this.cfg.npmPath ? { npmPath: this.cfg.npmPath } : {}),
    };
    let child: { pid: number | undefined };
    try { child = this.seams.spawnChild([this.cfg.mainScript, '--run-id', runId, '--input-json', JSON.stringify(input)], this.cfg.agentHome); }
    catch { child = { pid: undefined }; } // @silent-fallback-ok — recorded as spawn-failed below
    if (!child.pid) {
      this.markFinished(record, 'finished', 'spawn failed');
      return { started: false, reason: 'spawn-failed' };
    }
    record.pid = child.pid;
    record.pgid = child.pid; // detached: the child leads its own group
    record.state = 'spawned';
    // A failed write here is tolerated: recovery finds the group by run id.
    this.seams.writeDurable(this.runFile, JSON.stringify(record));
    const { done } = this.track(record);
    return { started: true, runId, done };
  }

  private track(record: ReclaimRunRecord): { done: Promise<void> } {
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const timers: Array<{ cancel(): void }> = [];
    this.current = { record, done, resolve, timers, killed: false };
    const pollMs = this.cfg.pollMs ?? 5_000;
    const poll = async (): Promise<void> => {
      const verdict = await this.resolveOwnership(record);
      if (verdict === 'gone') {
        for (const t of timers) t.cancel();
        this.markFinished(record, 'finished', 'process group gone');
        if (this.current?.record.runId === record.runId) this.current = null;
        resolve();
        return;
      }
      // 'alive' or 'unknown': keep holding exclusion.
      if (this.seams.now() >= record.deadline) await this.killIfCorroborated(record);
      timers.push(this.seams.setTimer(() => { void poll(); }, pollMs));
    };
    timers.push(this.seams.setTimer(() => { void poll(); }, Math.min(pollMs, 2_000)));
    return { done };
  }

  /** Escalating kill of a corroborated group past its deadline. Never kills an uncorroborated group. */
  private async killIfCorroborated(record: ReclaimRunRecord): Promise<void> {
    if (record.pgid === undefined) return;
    if (this.current && this.current.record.runId === record.runId && this.current.killed) return;
    const members = await this.seams.groupMembers(record.pgid);
    if (!members || !members.some((m) => m.command.includes(record.runId))) return;
    if (this.current?.record.runId === record.runId) this.current.killed = true;
    try { this.seams.killGroup(record.pgid, 'SIGTERM'); } catch { /* @silent-fallback-ok — already gone */ }
    const pgid = record.pgid;
    this.seams.setTimer(() => {
      void (async () => {
        const again = await this.seams.groupMembers(pgid);
        if (again && again.some((m) => m.command.includes(record.runId))) {
          try { this.seams.killGroup(pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already gone */ }
        }
      })();
    }, this.cfg.killGraceMs ?? 10_000);
  }

  private markFinished(record: ReclaimRunRecord, state: 'finished' | 'stale', reason: string): void {
    record.state = state;
    record.finishedAt = this.seams.now();
    record.finishReason = reason;
    this.seams.writeDurable(this.runFile, JSON.stringify(record));
  }

  /**
   * Attempt outcomes not yet fed to the breaker, each attempt at most once
   * across restarts (consumed ids are kept in a file). Only runs that are not
   * live are read. An open attempt (no terminal row) is reconciled with the
   * disk: its trash path exists ⇒ leftover trash, not a failure; its original
   * path exists and its trash path does not ⇒ died before the rename ⇒ one failure.
   */
  async collectOutcomes(): Promise<ReclaimAttemptOutcome[]> {
    let files: string[];
    try { files = (await fs.promises.readdir(this.runsDir)).filter((f) => f.endsWith('.jsonl')).sort(); }
    catch { return []; } // @silent-fallback-ok — no runs yet
    const liveRun = this.current?.record.runId ?? this.unresolved?.runId ?? null;
    const consumed = await this.readConsumed();
    const out: ReclaimAttemptOutcome[] = [];
    for (const f of files) {
      const runId = f.slice(0, -'.jsonl'.length);
      if (runId === liveRun) continue;
      const raw = await this.seams.readFile(path.join(this.runsDir, f));
      if (!raw) continue;
      const attempts = new Map<string, { path: string; trash?: string; terminal?: ReclaimRow }>();
      for (const r of parseRows(raw)) {
        if (!r.attemptId) continue;
        if (r.t === 'attempt' && typeof r.path === 'string') attempts.set(r.attemptId, { path: r.path });
        const a = attempts.get(r.attemptId);
        if (!a) continue;
        if (r.t === 'renaming' && typeof r.trash === 'string') a.trash = r.trash;
        if (r.t === 'removed' || r.t === 'kept' || r.t === 'error') a.terminal = r;
      }
      for (const [attemptId, a] of attempts) {
        if (consumed.has(attemptId)) continue;
        consumed.add(attemptId);
        if (a.terminal?.t === 'removed') { out.push({ attemptId, path: a.path, kind: 'removed' }); continue; }
        if (a.terminal?.t === 'error') { out.push({ attemptId, path: a.path, kind: 'failed', reason: String(a.terminal.reason ?? '') }); continue; }
        if (a.terminal?.t === 'kept') continue;
        // Open attempt: reconcile with the disk, not only the rows.
        const trash = a.trash ?? path.join(this.cfg.worktreesDir, WORKTREE_TRASH_DIRNAME, attemptId);
        if (await this.seams.exists(trash)) continue; // leftover trash; the next run's cleanup takes it
        if (await this.seams.exists(a.path)) out.push({ attemptId, path: a.path, kind: 'failed', reason: 'run ended mid-attempt before the rename' });
        // Neither exists: renamed and its trash already deleted — not a failure.
      }
    }
    await this.writeConsumed(consumed);
    return out;
  }

  private async readConsumed(): Promise<Set<string>> {
    const raw = await this.seams.readFile(this.consumedFile);
    if (!raw) return new Set();
    try { const arr = JSON.parse(raw) as unknown; return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []); }
    catch { return new Set(); } // @silent-fallback-ok — a torn file: attempts may be re-read once, the bounded breaker absorbs it
  }

  private async writeConsumed(ids: Set<string>): Promise<void> {
    const arr = [...ids].slice(-5_000);
    this.seams.writeDurable(this.consumedFile, JSON.stringify(arr));
  }

  async readReport(): Promise<ReclaimReportFile | null> {
    const raw = await this.seams.readFile(this.reportPath);
    if (!raw) return null;
    try {
      const r = JSON.parse(raw) as ReclaimReportFile;
      return r && typeof r === 'object' && Array.isArray(r.worktrees) ? r : null;
    } catch { return null; } // @silent-fallback-ok — no readable report ⇒ the route reads 'no pass has finished yet'
  }
}

/** Parse `ps -o pid=,pgid=,command=` output. */
export function parseGroupMembers(out: string): ReclaimGroupMember[] {
  const members: ReclaimGroupMember[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (m) members.push({ pid: Number(m[1]), command: m[3] ?? '' });
  }
  return members;
}

export function realReclaimRunnerSeams(nodePath: string = process.execPath): ReclaimRunnerSeams {
  return {
    spawnChild: (args, cwd) => {
      const useNice = process.platform !== 'win32';
      const child = spawn(useNice ? 'nice' : nodePath, useNice ? ['-n', '10', nodePath, ...args] : args, { detached: true, stdio: 'ignore', cwd });
      child.unref();
      return { pid: child.pid };
    },
    groupMembers: async (pgid) => {
      if (!Number.isInteger(pgid) || pgid <= 1) return null;
      try {
        const { stdout } = await execFileAsync('ps', ['-o', 'pid=,pgid=,command=', '-g', String(pgid)], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
        return parseGroupMembers(stdout).filter((m) => m.pid > 0);
      } catch (err) {
        // ps exits 1 with no output when the group has no members: a known answer.
        const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (e.code === 1 && typeof e.stdout === 'string' && e.stdout.trim() === '' && (typeof e.stderr !== 'string' || e.stderr.trim() === '')) return [];
        return null; // @silent-fallback-ok — unreadable ⇒ ownership unknown ⇒ exclusion held, nothing killed
      }
    },
    findGroupByArgs: async (needles) => {
      try {
        const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
        for (const m of parseGroupMembers(stdout)) {
          if (needles.every((n) => m.command.includes(n))) {
            const line = stdout.split('\n').find((l) => l.trim().startsWith(`${m.pid} `));
            const pgid = line ? Number(line.trim().split(/\s+/)[1]) : NaN;
            return Number.isInteger(pgid) && pgid > 1 ? pgid : null;
          }
        }
        return null;
      } catch {
        return null; // @silent-fallback-ok — no group found ⇒ the record is treated as gone (nothing killed)
      }
    },
    killGroup: (pgid, signal) => { process.kill(-pgid, signal); },
    writeDurable: (file, data) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        const fd = fs.openSync(tmp, 'w', 0o600);
        try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
        return true;
      } catch {
        return false; // @silent-fallback-ok — the caller treats false as "not durable" (no spawn on intent)
      }
    },
    appendRow: (file, row) => {
      try { appendDurableRow(file, row); return true; }
      catch { return false; } // @silent-fallback-ok — the caller treats false as "not durable" (no spawn on intent)
    },
    readFile: async (file) => { try { return await fs.promises.readFile(file, 'utf8'); } catch { return null; } }, // @silent-fallback-ok — absent
    exists: async (file) => { try { await fs.promises.lstat(file); return true; } catch { return false; } }, // @silent-fallback-ok — absent
    bootTime: () => Date.now() - os.uptime() * 1000,
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; },
  };
}

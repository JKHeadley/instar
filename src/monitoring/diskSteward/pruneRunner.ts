/**
 * Disk Steward — server side of the prune child (spec docs/specs/disk-steward.md §3.6).
 *
 * The server owns the deadline. Before spawning it records the intent in
 * `run.json`; after spawning it adds pid/pgid. A run is live while any member
 * of its process group exists. At the deadline the whole group is killed. At
 * boot a recorded group is acted on only after its identity is corroborated (a
 * member's command line carries the run id); an uncorroborated record (a reused
 * pid after a reboot) is never killed, only marked stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import type { PruneChildInput, PruneChildResult } from '../diskStewardMain.js';
import { withSyncOp } from '../../core/InFlightSyncOpMarker.js';

export interface RunRecord {
  runId: string;
  deadline: number;
  resultPath: string;
  startedAt: number;
  trigger: 'auto' | 'manual';
  dryRun: boolean;
  pid?: number;
  pgid?: number;
  stale?: true;
}

export interface RunnerSeams {
  spawnChild(args: string[]): { pid: number | undefined };
  groupAlive(pgid: number): boolean;
  killGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Command lines of every process in a group; null when unreadable. */
  groupCommands(pgid: number): string[] | null;
  /** pgid of a process whose command line contains `needle`, null when none. */
  findGroupByArg(needle: string): number | null;
  readFile(p: string): string | null;
  writeFile(p: string, data: string): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

export interface PruneRequest {
  trigger: 'auto' | 'manual';
  dryRun: boolean;
  measure: boolean;
  requestedBy?: { sessionId?: string; topicId?: number } | null;
}

export class PruneRunner {
  private current: { record: RunRecord; done: Promise<PruneChildResult | null>; resolve: (r: PruneChildResult | null) => void; timers: Array<{ cancel(): void }> } | null = null;

  constructor(
    private readonly cfg: { stateDir: string; agent: string; agentHome: string; mainScript: string; nodePath: string; npmCacheMaxGiB: () => number; auditPath: string; categoryBudgetMs?: number; runBudgetMs?: number },
    private readonly seams: RunnerSeams = realRunnerSeams(),
  ) {}

  private get runFile(): string { return path.join(this.cfg.stateDir, 'run.json'); }

  running(): RunRecord | null { return this.current ? { ...this.current.record } : null; }

  /** Start a run. null when one is already live (the caller reports 409 with its id). */
  start(req: PruneRequest): { record: RunRecord; done: Promise<PruneChildResult | null> } | null {
    if (this.current) return null;
    const runId = crypto.randomBytes(12).toString('hex');
    const now = this.seams.now();
    const runBudget = this.cfg.runBudgetMs ?? 30 * 60_000;
    const record: RunRecord = {
      runId, deadline: now + runBudget, resultPath: path.join(this.cfg.stateDir, `result-${runId}.json`),
      startedAt: now, trigger: req.trigger, dryRun: req.dryRun,
    };
    const input: PruneChildInput = {
      runId, agent: this.cfg.agent, agentHome: this.cfg.agentHome, trigger: req.trigger, requestedBy: req.requestedBy ?? null,
      dryRun: req.dryRun, npmCacheMaxGiB: this.cfg.npmCacheMaxGiB(), categoryBudgetMs: this.cfg.categoryBudgetMs ?? 10 * 60_000,
      measure: req.measure, resultPath: record.resultPath, auditPath: this.cfg.auditPath,
    };
    // Intent first: a crash between here and the spawn is resolvable at boot by the run id.
    this.seams.writeFile(this.runFile, JSON.stringify(record));
    const child = this.seams.spawnChild([this.cfg.mainScript, '--run-id', runId, '--input-json', JSON.stringify(input)]);
    if (child.pid) { record.pid = child.pid; record.pgid = child.pid; this.seams.writeFile(this.runFile, JSON.stringify(record)); }
    return this.track(record);
  }

  private track(record: RunRecord): { record: RunRecord; done: Promise<PruneChildResult | null> } {
    let resolve!: (r: PruneChildResult | null) => void;
    const done = new Promise<PruneChildResult | null>((r) => { resolve = r; });
    const timers: Array<{ cancel(): void }> = [];
    this.current = { record, done, resolve, timers };
    const finish = (r: PruneChildResult | null) => {
      for (const t of timers) t.cancel();
      if (this.current?.record.runId === record.runId) this.current = null;
      resolve(r);
    };
    const poll = () => {
      const raw = this.seams.readFile(record.resultPath);
      if (raw) {
        try { finish(JSON.parse(raw) as PruneChildResult); return; } catch { /* @silent-fallback-ok — partially written; poll again */ }
      }
      if (record.pgid !== undefined && !this.seams.groupAlive(record.pgid)) { finish(this.readResult(record)); return; }
      if (record.pgid === undefined) { finish(null); return; }
      if (this.seams.now() >= record.deadline) {
        this.kill(record);
        finish(this.readResult(record));
        return;
      }
      timers.push(this.seams.setTimer(poll, 5_000));
    };
    timers.push(this.seams.setTimer(poll, 2_000));
    return { record, done };
  }

  private readResult(record: RunRecord): PruneChildResult | null {
    const raw = this.seams.readFile(record.resultPath);
    if (!raw) return null;
    try { return JSON.parse(raw) as PruneChildResult; } catch { return null; } // @silent-fallback-ok — unrecorded run
  }

  private corroborated(pgid: number, runId: string): boolean | null {
    const cmds = this.seams.groupCommands(pgid);
    if (cmds === null) return null;
    return cmds.some((c) => c.includes(runId));
  }

  private kill(record: RunRecord): void {
    if (record.pgid === undefined || this.corroborated(record.pgid, record.runId) !== true) return;
    try { this.seams.killGroup(record.pgid, 'SIGTERM'); } catch { /* @silent-fallback-ok — already gone */ }
    this.seams.setTimer(() => {
      if (record.pgid !== undefined && this.seams.groupAlive(record.pgid) && this.corroborated(record.pgid, record.runId) === true) {
        try { this.seams.killGroup(record.pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already gone */ }
      }
    }, 10_000);
  }

  /**
   * Boot recovery. Returns the outcome so the steward can log it. A finished
   * result is returned as `collected`; a live corroborated run is tracked again.
   */
  recover(): { outcome: 'none' | 'collected' | 'adopted' | 'stale'; result?: PruneChildResult | null; record?: RunRecord } {
    const raw = this.seams.readFile(this.runFile);
    if (!raw) return { outcome: 'none' };
    let record: RunRecord;
    try { record = JSON.parse(raw) as RunRecord; } catch { return { outcome: 'none' }; }
    if (record.stale) return { outcome: 'none' };
    const result = this.readResult(record);
    if (result) return { outcome: 'collected', result, record };
    let pgid = record.pgid;
    if (pgid === undefined) pgid = this.seams.findGroupByArg(record.runId) ?? undefined;
    if (pgid !== undefined && this.seams.groupAlive(pgid) && this.corroborated(pgid, record.runId) === true) {
      record.pgid = pgid;
      this.track(record);
      if (this.seams.now() >= record.deadline) this.kill(record);
      return { outcome: 'adopted', record };
    }
    record.stale = true;
    this.seams.writeFile(this.runFile, JSON.stringify(record));
    return { outcome: 'stale', record };
  }
}

export function realRunnerSeams(nodePath: string = process.execPath): RunnerSeams {
  return {
    spawnChild: (args) => {
      const useNice = process.platform !== 'win32';
      const child = spawn(useNice ? 'nice' : nodePath, useNice ? ['-n', '10', nodePath, ...args] : args, {
        detached: true, stdio: 'ignore',
      });
      child.unref();
      return { pid: child.pid };
    },
    groupAlive: (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    killGroup: (pgid, signal) => { process.kill(-pgid, signal); },
    groupCommands: (pgid) => {
      try {
        // lint-allow-blocking-scan: runs only when a cleanup run hits its deadline or at boot recovery (rare, bounded 10 s).
        // lint-allow-sync-spawn: same one-shot call, funnelled through withSyncOp so the in-flight marker sees it.
        const out = withSyncOp(() => execFileSync('ps', ['-axww', '-o', 'pgid=,command='], { encoding: 'utf-8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }));
        return out.split('\n').map((l) => l.trim()).filter((l) => l.split(/\s+/)[0] === String(pgid)).map((l) => l.slice(l.indexOf(' ') + 1));
      } catch {
        return null; // @silent-fallback-ok — unreadable ⇒ never corroborated ⇒ never killed
      }
    },
    findGroupByArg: (needle) => {
      try {
        // lint-allow-blocking-scan: boot recovery only, once per boot, bounded 10 s.
        // lint-allow-sync-spawn: same one-shot call, funnelled through withSyncOp so the in-flight marker sees it.
        const out = withSyncOp(() => execFileSync('ps', ['-axww', '-o', 'pgid=,command='], { encoding: 'utf-8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }));
        for (const l of out.split('\n')) {
          const t = l.trim();
          if (t.includes(needle) && t.includes('diskStewardMain')) return Number(t.split(/\s+/)[0]) || null;
        }
        return null;
      } catch {
        return null; // @silent-fallback-ok — no group found ⇒ the record is marked stale, nothing killed
      }
    },
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }, // @silent-fallback-ok — absent result
    writeFile: (p, data) => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.tmp`;
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, p);
        return true;
      } catch {
        return false; // @silent-fallback-ok — full disk: the run still starts; boot recovery finds it by run id
      }
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; },
  };
}

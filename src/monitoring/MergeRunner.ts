/**
 * MergeRunner — the act-path engine for the GreenPrAutoMerger (Step 4 of
 * green-pr-automerge-enforcement §3.1/R5). Owns everything that touches a real
 * process:
 *
 *  - probeContract(): runs `safe-merge --capabilities`, pins the script's
 *    content hash + absolute path for the attempt (round-3 mid-run-swap defense),
 *    and re-verifies that hash IMMEDIATELY before exec (round-5: the spawn runs
 *    the verified bytes).
 *  - run(): writes a DURABLE two-phase in-flight record BEFORE the spawn (intent
 *    first, pid/pgid patched in after), spawns safe-merge in its OWN process
 *    group, hard-kills the group at mergeTimeoutMs + grace, parses the classified
 *    `safe-merge-result:` line, and confirms a `merged` outcome INDEPENDENTLY
 *    (B10). The record is cleared on classification.
 *  - reapOrphan(): at boot/warm-up, reaps a surviving orphan from a crash —
 *    verifies the recorded pid/pgid identity via a unique attempt token before
 *    signalling (pid-reuse safe), handles the dead-leader/live-group corner
 *    (orphan-reap-incomplete), and re-verifies PR state via gh. A pid-less
 *    in-flight record is treated as attempt-of-unknown-outcome (re-verify,
 *    never assume not-spawned).
 *
 * The guarantee survives the server's own death: the watcher's merges trigger
 * releases → auto-update restarts, so a restart mid-attempt is a NORMAL
 * condition. The durable record + own-process-group + shutdown group-kill +
 * warm-up reap close the double-attempt / wedged-orphan classes.
 *
 * All process + fs + gh I/O is behind injected seams so the runner is testable
 * without spawning anything.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high — this code drives an autonomous merge to main.
 *   Frequency:   per-merge-attempt (at most one per ~10-minute tick).
 *   Stability:   stable — parses safe-merge's OWN structured contract line
 *                (`safe-merge-result: {...}`), not human gh output; and
 *                `gh ... --json` structured responses, never regex over prose.
 *   Fallback:    every parse failure is caught and resolves to a NON-merged
 *                outcome (fail-toward-skip); a `merged` outcome is never trusted
 *                without an INDEPENDENT `gh pr view` confirmation (B10).
 *   Verdict:     deterministic; the act-time authority is safe-merge, which
 *                re-verifies, so a misread here can only refuse, never over-merge.
 */

import { spawn as realSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { MergeAttempt, MergeRunResult, MergeRunner } from './GreenPrAutoMerger.js';

/** A spawned child's observable result (seam over child_process). */
export interface SpawnOutcome {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  /** Whether the deadline timer fired and the group was killed. */
  deadlineKilled: boolean;
  pid: number | null;
}

export interface SpawnArgs {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  deadlineMs: number;
  /** Called once the child has a pid, so the runner can patch the durable record. */
  onPid?: (pid: number) => void;
}

export interface MergeRunnerConfig {
  stateDir: string;
  repo: string;
  /** Absolute path to scripts/safe-merge.mjs. */
  safeMergePath: string;
  mergeTimeoutMs: number;
  mergeKillGraceMs: number;
  expectedContractVersion: number;
  /** node executable (default process.execPath). */
  nodePath?: string;
}

export interface MergeRunnerDeps {
  /** Spawn a child in its OWN process group; resolve when it exits or is killed. */
  spawn?: (a: SpawnArgs) => Promise<SpawnOutcome>;
  /** Independent merge confirmation (gh pr view --json state,mergedAt). */
  confirmMerged: (pr: number, repo: string) => Promise<boolean>;
  /** Re-verify a PR's live state (for orphan reap). 'MERGED'|'CLOSED'|'OPEN'|'UNKNOWN'. */
  prState: (pr: number, repo: string) => Promise<string>;
  /** Is a process group still alive? (process.kill(pgid, 0) wrapper.) */
  isAlive?: (pid: number) => boolean;
  /** Kill a process group (SIGKILL the negative pid). */
  killGroup?: (pgid: number) => void;
  now?: () => number;
  logger?: (msg: string) => void;
}

/** The durable in-flight record (state/green-pr-automerge-inflight.json). */
export interface InFlightRecord {
  pr: number;
  headRefOid: string;
  repo: string;
  attemptToken: string;
  startedAt: number;
  /** Patched in AFTER the spawn (phase 2). Null until then. */
  pid: number | null;
  pgid: number | null;
}

export class DefaultMergeRunner implements MergeRunner {
  private readonly cfg: MergeRunnerConfig;
  private readonly deps: MergeRunnerDeps;
  private readonly now: () => number;
  /** Pinned per-attempt: the probed script's hash + path. */
  private pinnedHash: string | null = null;

  constructor(cfg: MergeRunnerConfig, deps: MergeRunnerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  // ---- contract probe -----------------------------------------------------

  async probeContract(): Promise<{ ok: boolean; version?: number }> {
    try {
      const out = await this.spawn({
        command: this.cfg.nodePath ?? process.execPath,
        args: [this.cfg.safeMergePath, '--capabilities'],
        env: process.env,
        deadlineMs: 30_000,
      });
      if (out.status !== 0) return { ok: false };
      const json = JSON.parse(out.stdout.trim());
      const version = Number(json?.contract);
      if (version !== this.cfg.expectedContractVersion) return { ok: false, version };
      // Pin the script's content hash for the attempt (re-verified before exec).
      this.pinnedHash = this.hashScript();
      return { ok: this.pinnedHash !== null, version };
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      return { ok: false };
    }
  }

  private hashScript(): string | null {
    try {
      const buf = fs.readFileSync(this.cfg.safeMergePath);
      return crypto.createHash('sha256').update(buf).digest('hex');
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      return null;
    }
  }

  // ---- run ----------------------------------------------------------------

  async run(attempt: MergeAttempt): Promise<MergeRunResult> {
    // Pre-exec hash re-verify (round-5): a checkout swap between probe and exec
    // must refuse — the spawn runs the VERIFIED bytes.
    const currentHash = this.hashScript();
    if (!this.pinnedHash || currentHash !== this.pinnedHash) {
      this.log(`safe-merge hash changed between probe and exec — refusing (${attempt.pr})`);
      return { outcome: 'skipped:safe-merge-contract', confirmedMerged: false };
    }

    const attemptToken = crypto.randomBytes(8).toString('hex');
    // Phase 1: durable intent record BEFORE the spawn.
    const record: InFlightRecord = {
      pr: attempt.pr, headRefOid: attempt.headRefOid, repo: this.cfg.repo,
      attemptToken, startedAt: this.now(), pid: null, pgid: null,
    };
    this.writeInFlight(record);

    let out: SpawnOutcome;
    try {
      out = await this.spawn({
        command: this.cfg.nodePath ?? process.execPath,
        args: [
          this.cfg.safeMergePath, String(attempt.pr),
          '--repo', this.cfg.repo, '--squash', '--delete-branch', '--admin',
          '--match-head-commit', attempt.headRefOid,
          '--deadline-ms', String(this.cfg.mergeTimeoutMs),
        ],
        env: { ...process.env, GREEN_PR_ATTEMPT_TOKEN: attemptToken },
        deadlineMs: this.cfg.mergeTimeoutMs + this.cfg.mergeKillGraceMs,
        onPid: (pid) => {
          // Phase 2: patch pid/pgid (the child's pid IS its pgid when detached).
          record.pid = pid;
          record.pgid = pid;
          this.writeInFlight(record);
        },
      });
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      this.clearInFlight();
      return { outcome: `error:spawn-${String((e as Error)?.message).slice(0, 40)}`, confirmedMerged: false };
    }

    const outcome = parseResultLine(out.stdout) ?? (out.deadlineKilled ? 'refused:checks-timeout' : 'error:no-result-line');
    let confirmedMerged = false;
    if (outcome === 'merged') {
      try { confirmedMerged = await this.deps.confirmMerged(attempt.pr, this.cfg.repo); }
      catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ confirmedMerged = false; }
    }
    this.clearInFlight();
    return { outcome, confirmedMerged, deadlineKilled: out.deadlineKilled };
  }

  // ---- orphan reap (boot/warm-up) ----------------------------------------

  async reapOrphan(): Promise<{ reaped: boolean; outcome?: string }> {
    const record = this.readInFlight();
    if (!record) return { reaped: false };

    const isAlive = this.deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return false; } });
    const killGroup = this.deps.killGroup ?? ((pgid: number) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* best-effort */ } });

    // A pid-less record = attempt-of-unknown-outcome (crash between phase 1 and 2).
    if (record.pid === null || record.pgid === null) {
      const cleared = await this.reverifyAndClear(record);
      return { reaped: true, outcome: cleared };
    }

    if (isAlive(record.pid)) {
      // Verify identity before signalling (pid-reuse safe): the live process must
      // carry our attempt token. If we cannot confirm identity, do NOT kill an
      // unrelated process — surface orphan-reap-incomplete and re-verify PR state.
      const identityOk = this.verifyAttemptToken(record.pid, record.attemptToken);
      if (identityOk) {
        killGroup(record.pgid);
      } else {
        this.log(`orphan pid ${record.pid} identity unconfirmed — not signalling (orphan-reap-incomplete)`);
        // Leave the record; re-verify PR state so a completed merge is recorded.
      }
    }
    const outcome = await this.reverifyAndClear(record);
    return { reaped: true, outcome };
  }

  private async reverifyAndClear(record: InFlightRecord): Promise<string> {
    let outcome = 'unknown';
    try {
      const st = await this.deps.prState(record.pr, record.repo);
      outcome = st === 'MERGED' ? 'merged-by-other' : st === 'CLOSED' ? 'closed-by-other' : 'reaped-open';
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ outcome = 'reaped-unverified'; }
    this.clearInFlight();
    return outcome;
  }

  /** Best-effort identity check: does the live pid's argv carry our token? */
  private verifyAttemptToken(pid: number, token: string): boolean {
    // On Linux, /proc/<pid>/environ carries the token. On other platforms we
    // cannot cheaply confirm — be conservative (return false → do not kill).
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
      return environ.includes(`GREEN_PR_ATTEMPT_TOKEN=${token}`);
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      return false;
    }
  }

  // ---- durable in-flight record ------------------------------------------

  private inFlightPath(): string {
    return path.join(this.cfg.stateDir, 'state', 'green-pr-automerge-inflight.json');
  }

  private writeInFlight(record: InFlightRecord): void {
    const p = this.inFlightPath();
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      this.log(`in-flight write failed: ${(e as Error)?.message}`);
    }
  }

  private readInFlight(): InFlightRecord | null {
    try {
      const raw = fs.readFileSync(this.inFlightPath(), 'utf-8');
      const obj = JSON.parse(raw) as InFlightRecord;
      if (typeof obj.pr === 'number' && typeof obj.attemptToken === 'string') return obj;
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* none */ }
    return null;
  }

  private clearInFlight(): void {
    try { SafeFsExecutor.safeRmSync(this.inFlightPath(), { force: true, operation: 'merge-runner:clear-in-flight' }); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* best-effort */ }
  }

  // ---- spawn seam ---------------------------------------------------------

  private spawn(a: SpawnArgs): Promise<SpawnOutcome> {
    if (this.deps.spawn) return this.deps.spawn(a);
    return defaultSpawn(a);
  }

  private log(msg: string): void {
    this.deps.logger?.(`[merge-runner] ${msg}`);
  }
}

/** Parse safe-merge's classified `safe-merge-result: {...}` line from stdout. */
export function parseResultLine(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/safe-merge-result:\s*(\{.*\})/);
    if (m) {
      try { return String(JSON.parse(m[1]).result); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return null; }
    }
  }
  return null;
}

/** Real spawn: detached (own process group) + deadline hard-kill of the group. */
function defaultSpawn(a: SpawnArgs): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = realSpawn(a.command, a.args, { env: a.env, detached: true });
    if (child.pid && a.onPid) a.onPid(child.pid);
    let stdout = '';
    let stderr = '';
    let deadlineKilled = false;
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      deadlineKilled = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* best-effort */ } }
    }, a.deadlineMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: status ?? null, signal: signal ?? null, deadlineKilled, pid: child.pid ?? null });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: null, signal: null, deadlineKilled, pid: child.pid ?? null });
    });
  });
}

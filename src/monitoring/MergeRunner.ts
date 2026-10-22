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
 *    signalling (pid-reuse safe), and re-verifies PR state via gh. The token is
 *    read from the child's argv (`ps -o args=`, macOS + Linux), with
 *    /proc/<pid>/environ as a Linux fallback. A LIVE process whose identity
 *    cannot be confirmed is never signalled and its record is KEPT
 *    (orphan-reap-incomplete): run() refuses new attempts
 *    (skipped:orphan-unresolved) until that pid is gone, then re-verifies PR
 *    state and clears it. A pid-less in-flight record is treated as
 *    attempt-of-unknown-outcome (re-verify, never assume not-spawned).
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

import { execFile, spawn as realSpawn } from 'node:child_process';
import { promisify } from 'node:util';
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
  /**
   * Explicit per-agent GitHub child environment. Null means the act path is
   * unavailable; the runner must not fall back to the machine-global gh seat.
   */
  resolveGitHubEnv: () => NodeJS.ProcessEnv | null;
  /**
   * Merge strategy (mergerunner-auto-arm-handoff). `auto` (default) arms GitHub
   * native auto-merge via `safe-merge … --auto` and returns in seconds; `admin`
   * is the legacy synchronous poll+merge via `--admin`. Absent → 'auto'.
   */
  mergeStrategy?: 'auto' | 'admin' | 'sync';
  /**
   * The `--auto` spawn deadline (default ~60s). Arming is a single API call, so
   * the 25-min `mergeTimeoutMs` is vestigial on the auto path — a hung arm
   * should trip in minutes, not ~26 min. The admin path keeps `mergeTimeoutMs`.
   */
  armTimeoutMs?: number;
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
  /** A live pid's command line (`ps -o args=`), null when unreadable. */
  readProcessArgs?: (pid: number) => string | null | Promise<string | null>;
  /** A live pid's environment block (Linux /proc/<pid>/environ), null when unreadable. */
  readProcessEnviron?: (pid: number) => string | null;
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
  /**
   * Set when a reap found the recorded pid ALIVE but could not confirm its
   * identity. The record is kept and blocks new attempts until the pid is gone.
   */
  reapIncompleteAt?: number;
  /**
   * The `--deadline-ms` this attempt's safe-merge was given. Past startedAt +
   * deadlineMs + kill grace + ORPHAN_FOREIGN_MARGIN_MS, a live unconfirmed pid
   * whose argv reads successfully and shows no safe-merge is presumed foreign.
   * (Elapsed time alone is not evidence: a hung safe-merge can outlive its
   * deadline.) Absent on older records; mergeTimeoutMs is used.
   */
  deadlineMs?: number;
}

/** Margin past an attempt's own deadline + kill grace before a live pid is presumed foreign. */
export const ORPHAN_FOREIGN_MARGIN_MS = 5 * 60_000;
/** Outcome when a live, unconfirmed pid past its bound reads as a non-safe-merge process and the record was cleared unsignalled. */
export const ORPHAN_PRESUMED_FOREIGN = 'orphan-presumed-foreign';

/** Outcome of run() while an unresolved orphan record blocks new attempts. */
export const ORPHAN_UNRESOLVED_OUTCOME = 'skipped:orphan-unresolved';
/** Outcome of reapOrphan() when a live, uncorroborated record was kept. */
export const ORPHAN_REAP_INCOMPLETE = 'orphan-reap-incomplete';

export class DefaultMergeRunner implements MergeRunner {
  private readonly cfg: MergeRunnerConfig;
  private readonly deps: MergeRunnerDeps;
  private readonly now: () => number;
  /** Pinned per-attempt: the probed script's hash + path. */
  private pinnedHash: string | null = null;
  /** Whether the probed safe-merge accepts `--attempt-token` (argv identity). */
  private argvToken = false;

  constructor(cfg: MergeRunnerConfig, deps: MergeRunnerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * The resolved merge strategy the runner will spawn with (mergerunner-auto-arm-
   * handoff M2). Read-only — exposed so the wiring-integrity test can prove the
   * config survived `config → GreenPrAutoMergerConfig → buildGreenPrDeps →
   * MergeRunnerConfig` and the runner is no longer hardcoded to `--admin`.
   */
  get resolvedStrategy(): 'auto' | 'admin' | 'sync' { return this.cfg.mergeStrategy ?? 'auto'; }
  /** The resolved `--auto` spawn deadline (M2 wiring-integrity surface). */
  get resolvedArmTimeoutMs(): number { return this.cfg.armTimeoutMs ?? 60_000; }

  // ---- contract probe -----------------------------------------------------

  async probeContract(): Promise<{ ok: boolean; version?: number }> {
    try {
      const githubEnv = this.cfg.resolveGitHubEnv();
      if (!githubEnv) return { ok: false };
      const out = await this.spawn({
        command: this.cfg.nodePath ?? process.execPath,
        args: [this.cfg.safeMergePath, '--capabilities'],
        env: githubEnv,
        deadlineMs: 30_000,
      });
      if (out.status !== 0) return { ok: false };
      const json = JSON.parse(out.stdout.trim());
      const version = Number(json?.contract);
      if (version !== this.cfg.expectedContractVersion) return { ok: false, version };
      this.argvToken = Array.isArray(json?.features) && json.features.includes('attempt-token');
      // Pin the script's content hash for the attempt (re-verified before exec).
      this.pinnedHash = this.hashScript();
      return { ok: this.pinnedHash !== null, version };
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      return { ok: false };
    }
  }

  /**
   * Hash safe-merge.mjs AND every module it imports from the repo (relative
   * specifiers, followed transitively), in a fixed order (sorted by path
   * relative to the script's directory). A change to ANY of them between the
   * probe and the exec refuses — the spawn runs the verified bytes, including
   * the floor/body-check modules it loads. Any unreadable file ⇒ null ⇒ refuse.
   */
  private hashScript(): string | null {
    try {
      return hashLocalImportClosure(this.cfg.safeMergePath);
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      return null;
    }
  }

  // ---- run ----------------------------------------------------------------

  async run(attempt: MergeAttempt): Promise<MergeRunResult> {
    // A surviving record from an earlier attempt is resolved first. A live,
    // uncorroborated one blocks: starting a new attempt alongside a live old
    // safe-merge is the double-attempt class the durable record exists to close.
    let priorRecord: string | undefined;
    const prior = this.readInFlight();
    if (prior) {
      const r = await this.reapRecord(prior);
      if (r.kept) {
        this.log(`in-flight record for #${prior.pr} (pid ${prior.pid}) unresolved — refusing #${attempt.pr}`);
        return { outcome: ORPHAN_UNRESOLVED_OUTCOME, confirmedMerged: false, priorRecord: r.outcome };
      }
      priorRecord = r.outcome;
    }
    // Pre-exec hash re-verify (round-5): a checkout swap between probe and exec
    // must refuse — the spawn runs the VERIFIED bytes.
    const currentHash = this.hashScript();
    if (!this.pinnedHash || currentHash !== this.pinnedHash) {
      this.log(`safe-merge hash changed between probe and exec — refusing (${attempt.pr})`);
      return { outcome: 'skipped:safe-merge-contract', confirmedMerged: false, ...(priorRecord ? { priorRecord } : {}) };
    }
    const githubEnv = this.cfg.resolveGitHubEnv();
    if (!githubEnv) {
      this.log(`explicit GitHub runtime unavailable — refusing (${attempt.pr})`);
      return { outcome: 'skipped:github-runtime-unavailable', confirmedMerged: false, ...(priorRecord ? { priorRecord } : {}) };
    }

    // Strategy select (mergerunner-auto-arm-handoff). The default arm path spawns
    // `safe-merge … --auto` (GitHub native auto-merge; returns in seconds) with a
    // SHORT armTimeoutMs deadline; the legacy admin path keeps `--admin` + the
    // 25-min mergeTimeoutMs deadline.
    // `sync` (local-verify-merge-authority §2 "Merge deadline and flags"): the
    // synchronous path with NEITHER --auto nor --admin, under mergeTimeoutMs —
    // GitHub's refusal never depends on the login lacking admin rights. A
    // per-attempt `strategy: 'sync'` (the local floor) overrides the config.
    const strategy = attempt.strategy ?? this.cfg.mergeStrategy ?? 'auto';
    const strategyFlags = strategy === 'admin' ? ['--admin'] : strategy === 'sync' ? [] : ['--auto'];
    const pathTimeoutMs = strategy === 'auto'
      ? (this.cfg.armTimeoutMs ?? 60_000)
      : this.cfg.mergeTimeoutMs;

    const attemptToken = crypto.randomBytes(8).toString('hex');
    // Phase 1: durable intent record BEFORE the spawn.
    const record: InFlightRecord = {
      pr: attempt.pr, headRefOid: attempt.headRefOid, repo: this.cfg.repo,
      attemptToken, startedAt: this.now(), pid: null, pgid: null, deadlineMs: pathTimeoutMs,
    };
    this.writeInFlight(record);

    let out: SpawnOutcome;
    try {
      out = await this.spawn({
        command: this.cfg.nodePath ?? process.execPath,
        args: [
          this.cfg.safeMergePath, String(attempt.pr),
          '--repo', this.cfg.repo, '--squash', '--delete-branch', ...strategyFlags,
          '--match-head-commit', attempt.headRefOid,
          '--deadline-ms', String(pathTimeoutMs),
          // On argv as well as env so `ps -o args=` can corroborate an orphan's
          // identity on macOS (no /proc). Only when the probed script accepts it.
          ...(this.argvToken ? ['--attempt-token', attemptToken] : []),
        ],
        // INSTAR_MERGE_FLOOR is a manual override for a human running safe-merge;
        // the server's own environment must never carry it into the watcher's merges.
        env: { ...withoutMergeFloorOverride(githubEnv), GREEN_PR_ATTEMPT_TOKEN: attemptToken },
        deadlineMs: pathTimeoutMs + this.cfg.mergeKillGraceMs,
        onPid: (pid) => {
          // Phase 2: patch pid/pgid (the child's pid IS its pgid when detached).
          record.pid = pid;
          record.pgid = pid;
          this.writeInFlight(record);
        },
      });
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      this.clearInFlight();
      return { outcome: `error:spawn-${String((e as Error)?.message).slice(0, 40)}`, confirmedMerged: false, ...(priorRecord ? { priorRecord } : {}) };
    }

    const raw = parseResultLine(out.stdout) ?? (out.deadlineKilled ? 'refused:checks-timeout' : 'error:no-result-line');
    // Map safe-merge's `--auto` classification → orchestrator outcome.
    //   auto-merge-armed (exit 5) → 'armed' (terminal-success-pending; carry head)
    //   merged (exit 0, immediate-green) → 'merged' (synchronous B10 confirm below)
    //   everything else (refused:* / error:auto-arm-* / closed / already-merged) → as-is
    const outcome = raw === 'auto-merge-armed' ? 'armed' : raw;

    let confirmedMerged = false;
    if (outcome === 'merged') {
      // B10 unchanged for the synchronous merge (immediate-green, or the admin
      // path). The armed outcome is confirmed LATER by reconciliation, never here.
      try { confirmedMerged = await this.deps.confirmMerged(attempt.pr, this.cfg.repo); }
      catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ confirmedMerged = false; }
    }
    this.clearInFlight();
    const result: MergeRunResult = { outcome, confirmedMerged, deadlineKilled: out.deadlineKilled, ...(priorRecord ? { priorRecord } : {}) };
    if (outcome === 'armed') result.armedHead = attempt.headRefOid;
    return result;
  }

  // ---- orphan reap (boot/warm-up) ----------------------------------------

  async reapOrphan(): Promise<{ reaped: boolean; outcome?: string }> {
    const record = this.readInFlight();
    if (!record) return { reaped: false };
    const r = await this.reapRecord(record);
    return { reaped: !r.kept, outcome: r.outcome };
  }

  /**
   * Resolve one surviving in-flight record. Returns kept:true when the recorded
   * pid is ALIVE and its identity could not be corroborated: nothing is
   * signalled, the record stays (it is the only handle on that process), and
   * the outcome is orphan-reap-incomplete. Every other case re-verifies PR
   * state and clears the record.
   */
  private async reapRecord(record: InFlightRecord): Promise<{ kept: boolean; outcome: string }> {
    const isAlive = this.deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return false; } });
    const killGroup = this.deps.killGroup ?? ((pgid: number) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* best-effort */ } });

    // A pid-less record = attempt-of-unknown-outcome (crash between phase 1 and 2).
    if (record.pid === null || record.pgid === null) {
      return { kept: false, outcome: await this.reverifyAndClear(record) };
    }

    if (isAlive(record.pid)) {
      // Verify identity before signalling (pid-reuse safe): the live process must
      // carry our attempt token. If we cannot confirm identity, do NOT kill a
      // possibly-unrelated process, and do NOT drop the record either.
      const id = await this.verifyAttemptToken(record.pid, record.attemptToken);
      if (!id.confirmed) {
        // Bound on the pid-reuse wedge, on POSITIVE evidence only. Elapsed time
        // alone proves nothing: the --auto path's gh calls carry no timeout, so
        // a hung safe-merge can outlive its deadline. Past the attempt's
        // deadline + kill grace + margin, the record is cleared (WITHOUT a kill,
        // after re-verifying PR state) only when the argv read SUCCEEDED and
        // shows no safe-merge at all — a foreign process reusing the pid. A
        // failed read, or a safe-merge argv without our token (e.g. an older
        // attempt), keeps the record.
        const deadline = record.deadlineMs ?? this.cfg.mergeTimeoutMs;
        const pastBound = this.now() > record.startedAt + deadline + this.cfg.mergeKillGraceMs + ORPHAN_FOREIGN_MARGIN_MS;
        if (pastBound && id.argsRead && !id.safeMergeOnArgv) {
          const pr = await this.reverifyAndClear(record);
          this.log(`orphan pid ${record.pid} alive past its attempt deadline, identity unconfirmed — presumed foreign, record cleared unsignalled (PR #${record.pr}: ${pr})`);
          return { kept: false, outcome: ORPHAN_PRESUMED_FOREIGN };
        }
        this.log(`orphan pid ${record.pid} alive, identity unconfirmed — not signalling, record kept (${ORPHAN_REAP_INCOMPLETE})`);
        if (record.reapIncompleteAt == null) {
          record.reapIncompleteAt = this.now();
          this.writeInFlight(record);
        }
        return { kept: true, outcome: ORPHAN_REAP_INCOMPLETE };
      }
      killGroup(record.pgid);
    }
    return { kept: false, outcome: await this.reverifyAndClear(record) };
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

  /**
   * Identity check: does the live pid carry our attempt token? argv first
   * (`ps -o args=`: works on macOS and Linux; the token rides `--attempt-token`),
   * then the Linux /proc environ (GREEN_PR_ATTEMPT_TOKEN) for an attempt spawned
   * by a safe-merge that predates the argv flag. Unreadable ⇒ false ⇒ no kill.
   */
  private async verifyAttemptToken(pid: number, token: string): Promise<{ confirmed: boolean; argsRead: boolean; safeMergeOnArgv: boolean }> {
    const readArgs = this.deps.readProcessArgs ?? defaultReadProcessArgs;
    const readEnviron = this.deps.readProcessEnviron ?? defaultReadProcessEnviron;
    const args = await readArgs(pid);
    const argsRead = typeof args === 'string' && args.length > 0;
    // The pinned script (or any safe-merge.mjs — conservative: an argv that
    // looks like a safe-merge is never presumed foreign).
    const scriptOnArgv = argsRead && (args.includes(this.cfg.safeMergePath) || args.includes(path.resolve(this.cfg.safeMergePath)));
    const safeMergeOnArgv = scriptOnArgv || (argsRead && args.includes(path.basename(this.cfg.safeMergePath)));
    if (argsRead) {
      const words = args.split(/\s+/);
      const tokenPair = words.some((w, i) => w === '--attempt-token' && words[i + 1] === token);
      // Also require the pinned safe-merge script on the command line: a token
      // pair alone could ride an unrelated process's argv.
      if (tokenPair && scriptOnArgv) return { confirmed: true, argsRead, safeMergeOnArgv };
    }
    const environ = readEnviron(pid);
    const confirmed = !!environ && environ.split('\0').includes(`GREEN_PR_ATTEMPT_TOKEN=${token}`);
    return { confirmed, argsRead, safeMergeOnArgv };
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

const execFileAsync = promisify(execFile);

async function defaultReadProcessArgs(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch { /* @silent-fallback-ok: unreadable identity keeps the record (orphan-reap-incomplete) */
    return null;
  }
}

function defaultReadProcessEnviron(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
  } catch { /* @silent-fallback-ok: no /proc (macOS) or unreadable — the argv read is the primary identity source */
    return null;
  }
}

/** The child env without the manual INSTAR_MERGE_FLOOR override. Exported for tests. */
export function withoutMergeFloorOverride(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.INSTAR_MERGE_FLOOR;
  return out;
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

// ---- the import-closure hash (probe-time pin + pre-exec re-verify) ------------

const RELATIVE_SPECIFIER = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Relative module specifiers a JS module source imports (comments stripped first). */
export function relativeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(RELATIVE_SPECIFIER)) out.push(m[1]);
  return out;
}

/** Every file in the entry's relative-import closure, sorted by path relative to the entry's directory. */
export function localImportClosure(entry: string): string[] {
  const root = path.dirname(path.resolve(entry));
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf-8'); // throws on a missing import ⇒ the caller refuses
    for (const spec of relativeImports(src)) queue.push(path.resolve(path.dirname(file), spec));
  }
  return [...seen].sort((a, b) => {
    const ra = path.relative(root, a);
    const rb = path.relative(root, b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/** sha256 over (relative path, NUL, bytes, NUL) for each file of the closure, in the fixed order. */
export function hashLocalImportClosure(entry: string): string {
  const root = path.dirname(path.resolve(entry));
  const h = crypto.createHash('sha256');
  for (const file of localImportClosure(entry)) {
    h.update(path.relative(root, file));
    h.update('\0');
    h.update(fs.readFileSync(file));
    h.update('\0');
  }
  return h.digest('hex');
}

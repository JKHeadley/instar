/**
 * AgentWorktreeReaper — reclaims stale CLI-created agent worktrees under
 * `~/.instar/agents/<agent>/.worktrees/`.
 *
 * Distinct from WorktreeReaper (which manages WorktreeManager *bindings* under
 * `.instar/worktrees/` via the state-reconciliation matrix): the `.worktrees/`
 * worktrees created by `instar worktree create` are UNMANAGED — nothing prunes
 * them, so they accumulate (measured: ~120 / ~55GB), which is both a disk drain
 * and the macOS-indexing CPU drain that the Spotlight-exclusion marker mitigates.
 *
 * THE hard requirement: NEVER delete unmerged or dirty work. A worktree is
 * reap-eligible ONLY when ALL of these hold:
 *   - not in use (no live session/index lock AND no running process whose cwd is
 *     inside the worktree), and
 *   - clean (no uncommitted or untracked changes), and
 *   - merged (its branch's content is already in the default branch — including
 *     single-commit squash-merges, detected via `git cherry` patch-id).
 * When all three hold, removing the worktree loses NOTHING: the branch and its
 * commits remain in the repo (merged ⇒ content is in main; clean ⇒ no uncommitted
 * work), so only the working-dir checkout is reclaimed (re-creatable on demand.)
 * Staleness is deliberately NOT a gate: on a high-velocity fleet every branch is
 * rebased onto recent main, so commit/dir timestamps are uniformly "recent" and
 * cannot distinguish abandoned from active — "in use" (lock + live process cwd)
 * is the real signal. Any ambiguity → KEEP. Ships OFF + dry-run by default (the
 * only worktree path that deletes on a heuristic). Part of the Responsible
 * Resource Usage standard (OS resource hygiene).
 */

import { EventEmitter } from 'node:events';
import {
  type WorktreeEnumeration,
  type WorktreeEnumerationFailureHistoryPort,
  summarizeEnumerationError,
} from './worktreeEnumeration.js';

export interface AgentWorktreeReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  reapIntervalMs: number;
  /**
   * Delay before the ONE-TIME initial pass after start() (default 15 min).
   * Without it the reaper's first pass is a full `reapIntervalMs` (24h) after
   * boot — and because agent servers restart far more often than daily, the
   * interval timer resets forever and an enabled+armed reaper NEVER runs a
   * single pass (the 2026-07-02 incident: 86 worktrees / 25GB accumulated with
   * the feature switched on). The delay keeps the pass off the busy post-boot
   * window; <= 0 disables the initial pass (interval-only — the rollback lever).
   */
  initialPassDelayMs: number;
  /** Bounded blast radius per pass. */
  maxReapsPerPass: number;
  /**
   * Per-path consecutive-removal-failure breaker (No Unbounded Loops standard).
   * After this many consecutive `removeWorktree` failures for the SAME path, the
   * reaper stops attempting it (keeps it as `reclaim-failed`) until restart, so a
   * permanently-unremovable worktree can't be retried forever. 0 disables the brake.
   */
  maxReclaimFailuresPerPath: number;
  /**
   * When true (default), merged-detection falls back to GitHub merged-PR state to
   * catch MULTI-COMMIT squash-merges that `git cherry` (patch-id) cannot — the
   * disk-accumulation root cause where squash-merged worktrees are kept forever.
   * One `gh` call per sweep, fail-safe to cherry-only (KEEP) on any error. Set
   * false to disable the network call and restore the legacy cherry-only behavior.
   */
  githubMergeCheck: boolean;
}

export const DEFAULT_AGENT_WORKTREE_REAPER_CONFIG: AgentWorktreeReaperConfig = {
  enabled: false,
  dryRun: true,
  reapIntervalMs: 24 * 3600 * 1000,
  initialPassDelayMs: 15 * 60 * 1000,
  maxReapsPerPass: 20,
  maxReclaimFailuresPerPath: 3,
  githubMergeCheck: true,
};

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  headSha: string;
}

export type Verdict = 'keep' | 'reap-eligible';

export interface WorktreeEvaluation {
  path: string;
  branch: string | null;
  verdict: Verdict;
  /** The gate that forced KEEP, or 'merged-clean-idle' when reap-eligible. */
  reason: string;
}

/**
 * All signal sources injected so the classifier is unit-testable without git/fs.
 * Production wiring supplies git-backed implementations via SafeGitExecutor.
 */
export interface AgentWorktreeReaperDeps {
  /**
   * Worktrees under the agent's `.worktrees/` (excludes the main checkout).
   *
   * Returns a THREE-STATE result, not a bare array. The states are
   * success-nonempty, success-empty, and failure — and the whole point of this
   * type is that a caller cannot reach the worktrees without first passing
   * through `ok`. A bare array (or a throw, which is the same thing with the
   * failure state left implicit) let "could not look" and "looked, found nothing"
   * collapse into one value; that collapse reported a clean bill of health over a
   * broken guard twice in production.
   *
   * This is deliberately structural rather than documented: the compiler, not a
   * convention, is what stops the next caller from forgetting.
   */
  listWorktrees: () => WorktreeEnumeration<WorktreeInfo>;
  /** True when the worktree has NO uncommitted or untracked changes. */
  isClean: (path: string) => boolean;
  /** True when the branch's content is already in the default branch. */
  isMerged: (info: WorktreeInfo) => boolean;
  /** True when the worktree is in use: a live session/index lock OR a running
   *  process whose cwd is inside it. The real "don't yank it" signal. */
  isInUse: (path: string) => boolean;
  /** The worktree's LIVE currently-checked-out branch, read at RECLAIM time to close
   *  the enumerate→reclaim TOCTOU: `info.branch` is captured at enumeration, but a
   *  builder may `git checkout -b <new-unmerged>` before the reaper reaches the
   *  delete — and `isMerged(info)` would still check the STALE (merged) branch.
   *  Production: SafeGitExecutor `rev-parse --abbrev-ref HEAD` on the path. */
  currentBranch: (path: string) => string | null;
  /** Optional belt-and-suspenders: true when a `.instar-build-active` marker file sits
   *  at the worktree root — an in-flight builder's explicit "don't reap me" claim.
   *  Production: fs.existsSync(path/.instar-build-active). */
  hasActiveBuildMarker?: (path: string) => boolean;
  /** Remove the worktree (git worktree remove). Only called when killsEnabled. */
  removeWorktree: (path: string) => void;
  /** Passive trace for an enumeration failure. Retention follows the deployment log. */
  warn?: (line: string) => void;
  /** Restart-surviving failure count/time. Current blind state is never restored. */
  failureHistory?: WorktreeEnumerationFailureHistoryPort;
  now?: () => number;
}

// The enumeration contract lives in its own module so the sentinel does not have
// to import its diagnostics from the reaper. Re-exported for existing consumers.
export { type WorktreeEnumeration, MAX_ENUMERATION_ERROR_CHARS, summarizeEnumerationError } from './worktreeEnumeration.js';

export class AgentWorktreeReaper extends EventEmitter {
  private readonly cfg: AgentWorktreeReaperConfig;
  private readonly deps: AgentWorktreeReaperDeps;
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;
  private running = false;
  private lastPassAt = 0;
  private reapedLastPass = 0;
  /**
   * Metric (Observability standard): how many background REAP PASSES have failed
   * to enumerate in the retained history, and when the most recent one was.
   * Incremented ONLY by `reap()` — never by `snapshot()`, which runs per route hit
   * and would otherwise make this a measure of polling frequency. Without a count, the
   * only evidence a guard is blind is a log line someone has to be reading at the
   * right moment — and the defect this whole change addresses went unnoticed for
   * an unknown duration precisely because nothing counted it.
   */
  private enumerationFailures = 0;
  private lastEnumerationFailureAt: number | null = null;
  /** Current-process outcome of the last completed background pass. */
  private lastEnumerationOk: boolean | null = null;
  private lastEnumerationError: string | null = null;
  /** Per-path consecutive removal-failure counts (breaker). Keyed by worktree path;
   *  cleared on a successful removal of that path. Process-lifetime (resets on restart). */
  private reclaimFailures = new Map<string, number>();
  /** Paths whose breaker has tripped + already emitted (emit-once). */
  private reclaimTripped = new Set<string>();

  constructor(deps: AgentWorktreeReaperDeps, cfg?: Partial<AgentWorktreeReaperConfig>) {
    super();
    this.deps = deps;
    this.cfg = { ...DEFAULT_AGENT_WORKTREE_REAPER_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
    this.warn = deps.warn ?? ((line) => console.warn(line));
    try {
      const history = deps.failureHistory?.load();
      if (history) {
        this.enumerationFailures = history.enumerationFailures;
        this.lastEnumerationFailureAt = history.lastEnumerationFailureAt;
      }
    } catch (err) {
      // @silent-fallback-ok — not silent: the guard remains live and the failed
      // historical load is surfaced. Current-pass honesty does not depend on it.
      this.warn(`[agent-worktree-reaper] enumeration failure history load FAILED: ${summarizeEnumerationError(err)}`);
    }
  }

  start(): void {
    if (this.timer || !this.cfg.enabled) return;
    this.timer = setInterval(() => { void this.reap(); }, this.cfg.reapIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // One-time initial pass shortly after boot. Without it, the first pass is a
    // full reapIntervalMs (24h) away — which on real deployments (servers restart
    // more often than daily, resetting the interval) means NO pass ever runs.
    // Delayed past the busy post-boot window; disabled by initialPassDelayMs <= 0.
    if (this.cfg.initialPassDelayMs > 0) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = undefined;
        void this.reap();
      }, this.cfg.initialPassDelayMs);
      if (typeof this.initialTimer.unref === 'function') this.initialTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = undefined; }
  }

  private get killsEnabled(): boolean {
    return this.cfg.enabled && !this.cfg.dryRun;
  }

  /**
   * Pure, stateless per-worktree classifier. Returns KEEP unless EVERY safety
   * gate clears. Order: cheap protect-gates first (short-circuit on the first
   * KEEP) — never evaluate `isMerged` (a git call) on a dirty/active worktree.
   */
  evaluate(info: WorktreeInfo): WorktreeEvaluation {
    const keep = (reason: string): WorktreeEvaluation =>
      ({ path: info.path, branch: info.branch, verdict: 'keep', reason });

    if (this.deps.isInUse(info.path)) return keep('in-use');
    if (!info.branch) return keep('detached-or-unknown-branch');
    if (!this.deps.isClean(info.path)) return keep('uncommitted-changes');
    if (!this.deps.isMerged(info)) return keep('unmerged');
    return { path: info.path, branch: info.branch, verdict: 'reap-eligible', reason: 'merged-clean-idle' };
  }

  /** One reap pass. Returns the per-worktree evaluations + what was reaped. */
  async reap(): Promise<{ ts: number; evaluations: WorktreeEvaluation[]; reaped: string[]; dryRun: boolean }> {
    if (this.running) return { ts: this.now(), evaluations: [], reaped: [], dryRun: !this.killsEnabled };
    this.running = true;
    const reaped: string[] = [];
    const evaluations: WorktreeEvaluation[] = [];
    try {
      // The `ok` narrowing is mandatory — `worktrees` is unreachable without it.
      const enumeration = this.deps.listWorktrees();
      if (!enumeration.ok) {
        // NOT `emit('error')`. Node's EventEmitter special-cases the 'error' event:
        // emitting it with NO listener THROWS. Nothing subscribes to this reaper in
        // production, and reap()'s body has only a `finally` — so an 'error' emit
        // here would escape as an unhandled rejection from the interval callback,
        // and it would do so precisely in the enumeration-failure case this change
        // exists to handle. A named, non-special event reports the same fact and
        // cannot crash a caller who is not listening.
        const failedAt = this.now();
        this.lastPassAt = failedAt;
        this.lastEnumerationOk = false;
        this.lastEnumerationError = enumeration.error;
        this.recordEnumerationFailure(failedAt);
        this.emit('enumeration-failed', { error: enumeration.error });
        this.warn(`[agent-worktree-reaper] enumeration FAILED — reclaimable is UNKNOWN, not zero: ${enumeration.error}`);
        return { ts: failedAt, evaluations: [], reaped: [], dryRun: !this.killsEnabled };
      }
      const worktrees: WorktreeInfo[] = enumeration.worktrees;

      for (const info of worktrees) {
        let evaln: WorktreeEvaluation;
        try { evaln = this.evaluate(info); }
        catch {
          // A signal threw — cannot reason about it, so KEEP. Never reap on a
          // failed evaluation.
          evaluations.push({ path: info.path, branch: info.branch, verdict: 'keep', reason: 'eval-error' });
          continue;
        }
        // Per-path failure breaker (No Unbounded Loops): a reap-eligible worktree
        // whose removal has failed too many times is no longer attempted — surfaced
        // honestly as keep('reclaim-failed') so the operator sees WHY it persists.
        if (evaln.verdict === 'reap-eligible' && this.breakerTripped(info.path)) {
          evaluations.push({ path: info.path, branch: info.branch, verdict: 'keep', reason: 'reclaim-failed' });
          continue;
        }
        evaluations.push(evaln);
        if (evaln.verdict !== 'reap-eligible') continue;
        if (reaped.length >= this.cfg.maxReapsPerPass) continue; // blast-radius cap
        if (!this.killsEnabled) { continue; } // dry-run: classify, do not delete
        // EXEC-TIME RE-VALIDATION (close the enumerate→reclaim TOCTOU): `info` was
        // captured by listWorktrees() at enumeration; a builder may have checked out a
        // new UNMERGED branch since, yet isMerged(info) checks the STALE branch. Re-read
        // the LIVE state right before the irreversible delete; on any race, ABORT this
        // reap (keep) — strictly FEWER reaps, never more (a pure safety tightening).
        const raceReason = this.reclaimRaceGuard(info);
        if (raceReason) {
          evaln.verdict = 'keep';
          evaln.reason = raceReason;
          this.emit('reclaim-raced', { path: info.path, reason: raceReason, evaluatedBranch: info.branch });
          continue;
        }
        try {
          this.deps.removeWorktree(info.path);
          reaped.push(info.path);
          this.reclaimFailures.delete(info.path); // success → clear the breaker count
          this.reclaimTripped.delete(info.path);
          this.emit('reaped', info);
        } catch (err) {
          // @silent-fallback-ok: NOT silent — the removal failure is surfaced via
          // emit('error') AND recorded for the per-path breaker (which itself
          // emit('reclaim-breaker')s once on trip). The worktree is simply kept and
          // retried (bounded by the breaker), the safe direction for a deletion op.
          this.recordReclaimFailure(info.path);
          this.emit('error', err);
        }
      }
      this.lastPassAt = this.now();
      this.lastEnumerationOk = true;
      this.lastEnumerationError = null;
      this.reapedLastPass = reaped.length;
      this.emit('pass', { evaluations, reaped });
    } finally {
      this.running = false;
    }
    return { ts: this.now(), evaluations, reaped, dryRun: !this.killsEnabled };
  }

  private recordEnumerationFailure(at: number): void {
    this.enumerationFailures = Math.min(Number.MAX_SAFE_INTEGER, this.enumerationFailures + 1);
    this.lastEnumerationFailureAt = at;
    try {
      const persisted = this.deps.failureHistory?.recordFailure(at);
      if (persisted) {
        this.enumerationFailures = persisted.enumerationFailures;
        this.lastEnumerationFailureAt = persisted.lastEnumerationFailureAt;
      }
    } catch (err) {
      // @silent-fallback-ok — not silent: retain the in-memory history and make
      // persistence degradation visible without disabling the safety guard.
      this.warn(`[agent-worktree-reaper] enumeration failure history persist FAILED: ${summarizeEnumerationError(err)}`);
    }
  }

  /** Cheap, in-memory posture read for GuardRegistry (`GET /guards`). */
  guardStatus(): {
    enabled: boolean;
    dryRun: boolean;
    lastTickAt: number;
    verdictUnknown?: true;
    verdictUnknownReason?: string;
  } {
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      lastTickAt: this.lastPassAt,
      ...(this.lastEnumerationOk === false
        ? { verdictUnknown: true as const, verdictUnknownReason: this.lastEnumerationError ?? 'worktree enumeration failed' }
        : {}),
    };
  }

  /**
   * Re-check the LIVE worktree state at RECLAIM time (after enumeration) to close the
   * TOCTOU. Returns a KEEP reason string if it raced (a builder changed the branch /
   * dirtied it / took it in-use / dropped a build marker since evaluation), else null
   * (safe to reclaim). Fail-closed: any thrown signal → keep('reclaim-recheck-error').
   * Order mirrors evaluate(): the marker + branch identity first (the load-bearing
   * TOCTOU checks), then the protect-gates re-confirmed against the STILL-CURRENT branch.
   */
  private reclaimRaceGuard(info: WorktreeInfo): string | null {
    try {
      if (this.deps.hasActiveBuildMarker?.(info.path)) return 'raced-build-active-marker';
      // The load-bearing check: has the checked-out branch changed since enumeration?
      // If so, isMerged(info) (which reads info.branch) is stale and must NOT authorize a delete.
      const liveBranch = this.deps.currentBranch(info.path);
      if (liveBranch !== info.branch) return 'raced-changed-since-eval';
      if (this.deps.isInUse(info.path)) return 'raced-now-in-use';
      if (!this.deps.isClean(info.path)) return 'raced-now-dirty';
      // Branch unchanged + clean + idle → info.branch is still current, so re-confirming
      // isMerged(info) is valid. (Belt: main may have moved, un-merging it.)
      if (!this.deps.isMerged(info)) return 'raced-now-unmerged';
      return null;
    } catch {
      // @silent-fallback-ok: NOT silent — returns a KEEP reason that is surfaced in the
      // worktree's verdict/reason (and the reclaim-raced event). Any thrown re-check
      // signal → keep, the delete-safe direction. Never a swallowed reap.
      return 'reclaim-recheck-error';
    }
  }

  /** True when this path's removal has failed >= the configured cap (breaker open).
   *  cap 0 disables the brake (never trips). */
  private breakerTripped(path: string): boolean {
    const cap = this.cfg.maxReclaimFailuresPerPath;
    if (cap <= 0) return false;
    return (this.reclaimFailures.get(path) ?? 0) >= cap;
  }

  /** Record one removal failure for a path; emit the breaker-trip ONCE when the cap is reached. */
  private recordReclaimFailure(path: string): void {
    const cap = this.cfg.maxReclaimFailuresPerPath;
    const n = (this.reclaimFailures.get(path) ?? 0) + 1;
    this.reclaimFailures.set(path, n);
    if (cap > 0 && n >= cap && !this.reclaimTripped.has(path)) {
      this.reclaimTripped.add(path);
      this.emit('reclaim-breaker', { path, failures: n });
    }
  }

  /**
   * Observability snapshot for GET /worktrees/agent-reaper (no side effects).
   *
   * FAIL-VISIBLE, not fail-silent. When enumeration throws we still do not crash
   * the route — but we MUST NOT report the failure as `reclaimable: 0`, because
   * "the check could not run" and "there is nothing to reclaim" are the same
   * bytes to a reader and opposite facts. That collapse is what let a
   * mis-wired repo path sit behind a clean bill of health while real worktrees
   * accumulated (2026-07-29: the reaper reported `reclaimable: 0` against 73
   * worktrees because `git -C <path> worktree list` was failing outright).
   *
   * `enumerationOk: false` + `reclaimable: null` is the honest shape: the
   * numbers are UNKNOWN, not zero. Callers that want a number must decide what
   * an unknown means for them rather than inheriting a fabricated zero.
   *
   * This mirrors `isClean`'s existing fail-closed contract in agentWorktreeGit:
   * a signal that cannot be determined must never resolve to the permissive
   * answer.
   */
  snapshot(): {
    enabled: boolean; dryRun: boolean; lastPassAt: number; reapedLastPass: number;
    initialPassPending: boolean;
    worktrees: WorktreeEvaluation[];
    reclaimable: number | null;
    enumerationOk: boolean;
    enumerationError: string | null;
    enumerationFailures: number;
    lastEnumerationFailureAt: number | null;
  } {
    let worktrees: WorktreeEvaluation[] = [];
    let enumerationOk = true;
    let enumerationError: string | null = null;
    // The three-state result makes the failure branch unskippable: there is no way
    // to read `.worktrees` without having answered `ok` first. A defensive try/catch
    // remains only for a dep that throws in violation of its contract — the route
    // must never 500 — but it is a backstop, not the mechanism.
    try {
      const enumeration = this.deps.listWorktrees();
      if (enumeration.ok) {
        worktrees = enumeration.worktrees.map((info) => {
          try { return this.evaluate(info); }
          catch { return { path: info.path, branch: info.branch, verdict: 'keep' as Verdict, reason: 'eval-error' }; }
        });
      } else {
        enumerationOk = false;
        enumerationError = enumeration.error;
      }
    } catch (err) {
      // Deliberately does NOT increment enumerationFailures. snapshot() runs on
      // every route hit, so counting here would make the metric a function of how
      // often someone polls rather than of how often the guard actually went
      // blind. `enumerationOk` already reports the CURRENT state; the counter
      // measures background PASSES.
      enumerationOk = false;
      enumerationError = summarizeEnumerationError(err);
      worktrees = [];
    }
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      lastPassAt: this.lastPassAt,
      reapedLastPass: this.reapedLastPass,
      initialPassPending: this.initialTimer !== undefined,
      worktrees,
      reclaimable: enumerationOk ? worktrees.filter((w) => w.verdict === 'reap-eligible').length : null,
      enumerationOk,
      enumerationError,
      enumerationFailures: this.enumerationFailures,
      lastEnumerationFailureAt: this.lastEnumerationFailureAt,
    };
  }
}

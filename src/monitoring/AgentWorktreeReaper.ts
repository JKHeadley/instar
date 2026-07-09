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
  /** Worktrees under the agent's `.worktrees/` (excludes the main checkout). */
  listWorktrees: () => WorktreeInfo[];
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
  now?: () => number;
}

export class AgentWorktreeReaper extends EventEmitter {
  private readonly cfg: AgentWorktreeReaperConfig;
  private readonly deps: AgentWorktreeReaperDeps;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;
  private running = false;
  private lastPassAt = 0;
  private reapedLastPass = 0;
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
      let worktrees: WorktreeInfo[];
      try { worktrees = this.deps.listWorktrees(); }
      catch (err) { this.emit('error', err); return { ts: this.now(), evaluations: [], reaped: [], dryRun: !this.killsEnabled }; }

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
      this.reapedLastPass = reaped.length;
      this.emit('pass', { evaluations, reaped });
    } finally {
      this.running = false;
    }
    return { ts: this.now(), evaluations, reaped, dryRun: !this.killsEnabled };
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

  /** Observability snapshot for GET /worktrees/agent-reaper (no side effects). */
  snapshot(): {
    enabled: boolean; dryRun: boolean; lastPassAt: number; reapedLastPass: number;
    initialPassPending: boolean;
    worktrees: WorktreeEvaluation[];
    reclaimable: number;
  } {
    let worktrees: WorktreeEvaluation[] = [];
    try {
      worktrees = this.deps.listWorktrees().map((info) => {
        try { return this.evaluate(info); }
        catch { return { path: info.path, branch: info.branch, verdict: 'keep' as Verdict, reason: 'eval-error' }; }
      });
    } catch { /* listing failed — report empty, never crash the route */ }
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      lastPassAt: this.lastPassAt,
      reapedLastPass: this.reapedLastPass,
      initialPassPending: this.initialTimer !== undefined,
      worktrees,
      reclaimable: worktrees.filter((w) => w.verdict === 'reap-eligible').length,
    };
  }
}

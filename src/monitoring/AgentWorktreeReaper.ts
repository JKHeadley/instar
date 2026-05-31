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
  /** Bounded blast radius per pass. */
  maxReapsPerPass: number;
}

export const DEFAULT_AGENT_WORKTREE_REAPER_CONFIG: AgentWorktreeReaperConfig = {
  enabled: false,
  dryRun: true,
  reapIntervalMs: 24 * 3600 * 1000,
  maxReapsPerPass: 20,
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
  /** Remove the worktree (git worktree remove). Only called when killsEnabled. */
  removeWorktree: (path: string) => void;
  now?: () => number;
}

export class AgentWorktreeReaper extends EventEmitter {
  private readonly cfg: AgentWorktreeReaperConfig;
  private readonly deps: AgentWorktreeReaperDeps;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPassAt = 0;
  private reapedLastPass = 0;

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
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
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
        evaluations.push(evaln);
        if (evaln.verdict !== 'reap-eligible') continue;
        if (reaped.length >= this.cfg.maxReapsPerPass) continue; // blast-radius cap
        if (!this.killsEnabled) { continue; } // dry-run: classify, do not delete
        try {
          this.deps.removeWorktree(info.path);
          reaped.push(info.path);
          this.emit('reaped', info);
        } catch (err) {
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

  /** Observability snapshot for GET /worktrees/agent-reaper (no side effects). */
  snapshot(): {
    enabled: boolean; dryRun: boolean; lastPassAt: number; reapedLastPass: number;
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
      worktrees,
      reclaimable: worktrees.filter((w) => w.verdict === 'reap-eligible').length,
    };
  }
}

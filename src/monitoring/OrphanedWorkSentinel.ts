/**
 * OrphanedWorkSentinel — the silent-uncommitted-death backstop.
 *
 * The failure it closes (2026-06-12, topic 22367): a decoupled build/autonomous
 * session was spawned to do work in an agent worktree. It edited files, launched
 * its test suite in the BACKGROUND, said "standing by" — and the `claude -p`
 * turn ended, so the session died with all of its work UNCOMMITTED and no PR. No
 * commitment had been registered for the code itself, so the PromiseBeacon
 * escalation ladder (#1093/#1097) — which acts on REGISTERED promises — had
 * nothing to act on. The stranded work sat invisible for hours.
 *
 * This sentinel needs NOTHING registered. It reads the stranded work straight
 * off disk: an agent worktree with uncommitted changes (work) whose owning
 * session is DEAD (no live process cwd inside it, no session/index lock) and
 * that has been SETTLED for a while (no recent file activity — so we never grab
 * work that is merely paused mid-keystroke) is *orphaned work*. The sentinel
 * RECORDS it durably, raises ONE deduped attention item ("work was stranded
 * here — revive or discard"), and — only behind an explicit, off-by-default
 * sub-flag — creates a WIP preservation commit so the work can never be lost.
 *
 * Distinct from AgentWorktreeReaper, which is its INVERSE: the reaper reclaims
 * worktrees that are clean + merged + idle (KEEPS anything dirty); this sentinel
 * acts ONLY on the dirty + owner-dead + settled worktrees the reaper deliberately
 * leaves alone. They share the same git/fs signal sources.
 *
 * Posture: SIGNAL-ONLY by default — it records + surfaces, it never deletes and
 * never blocks. The optional preservation-commit only ADDS a commit (never
 * destroys). developmentAgent dark-feature gate: the config OMITS `enabled`, so
 * resolveDevAgentGate runs it LIVE on a dev agent (the dogfooding ground) and
 * DARK on the fleet. Spec: docs/specs/ORPHANED-WORK-SENTINEL-SPEC.md.
 */

import { EventEmitter } from 'node:events';

export interface OrphanedWorkSentinelConfig {
  /** developmentAgent-gated at the wiring site; omitted from the default. */
  enabled: boolean;
  /** How often the sentinel scans the agent's worktrees. */
  scanIntervalMs: number;
  /**
   * A dirty + owner-dead worktree must have been idle (no file activity) for at
   * least this long before it counts as ORPHANED — guards against grabbing work
   * that is merely paused for a moment, not abandoned.
   */
  settleMs: number;
  /**
   * Optional: create a `wip:` preservation commit on the orphaned branch so the
   * work survives even if the worktree is later removed. OFF for everyone by
   * default (the dev-gate covers only the non-destructive detect+record+surface;
   * this sub-flag is the only mutation and is opt-in). Only ADDS a commit.
   */
  preserveWork: boolean;
  /** Bounded blast radius per scan pass (how many worktrees we'll flag at once). */
  maxFlagsPerPass: number;
}

export const DEFAULT_ORPHANED_WORK_SENTINEL_CONFIG: OrphanedWorkSentinelConfig = {
  enabled: false,
  scanIntervalMs: 10 * 60 * 1000, // 10 min
  settleMs: 8 * 60 * 1000, // 8 min idle ⇒ settled
  preserveWork: false,
  maxFlagsPerPass: 10,
};

export interface OrphanedWorktreeInfo {
  path: string;
  branch: string | null;
  headSha: string;
}

export type OrphanedVerdict = 'orphaned' | 'skip';

export interface OrphanedWorkEvaluation {
  path: string;
  branch: string | null;
  verdict: OrphanedVerdict;
  /** The gate that produced SKIP, or 'uncommitted-owner-dead-settled' when orphaned. */
  reason: string;
}

/** A durable record of a detected orphaned-work episode. */
export interface OrphanedWorkEvent {
  ts: number;
  path: string;
  branch: string | null;
  /** Short hash of the dirty `git status` so a re-scan of the SAME stranded
   *  state dedupes, but NEW changes re-flag. */
  workSig: string;
  preserved: boolean;
  preserveError?: string;
}

/**
 * All signal sources injected so the classifier + pass are unit-testable with
 * fakes; production wiring supplies git/fs-backed implementations.
 */
export interface OrphanedWorkSentinelDeps {
  /** Worktrees under the agent's `.worktrees/` (excludes the main checkout). */
  listWorktrees: () => OrphanedWorktreeInfo[];
  /** True when the worktree has uncommitted or untracked changes (the "work"). */
  hasUncommittedWork: (path: string) => boolean;
  /** A stable short signature of the current dirty state (for episode dedup). */
  workSignature: (path: string) => string;
  /** True when the worktree is in use: a live session/index lock OR a running
   *  process whose cwd is inside it. The "owner is alive — leave it" signal. */
  isInUse: (path: string) => boolean;
  /** Most recent file-activity time (ms epoch) inside the worktree, or null when
   *  unknown. Drives the settle gate. */
  lastActivityMs: (path: string) => number | null;
  /** Create a WIP preservation commit. Only called when preserveWork && !dryRun
   *  (here, preserveWork is the gate; there is no separate dryRun). Throws on
   *  failure; the caller records the error and continues. */
  preserve: (info: OrphanedWorktreeInfo) => void;
  /** Append a durable record of the episode. */
  record: (event: OrphanedWorkEvent) => void;
  /** Raise ONE deduped attention item for a stranded worktree. */
  raiseAttention: (event: OrphanedWorkEvent) => void;
  now?: () => number;
}

export class OrphanedWorkSentinel extends EventEmitter {
  private readonly cfg: OrphanedWorkSentinelConfig;
  private readonly deps: OrphanedWorkSentinelDeps;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPassAt = 0;
  /** Episode dedup: `${path}::${workSig}` already flagged this process-lifetime. */
  private readonly flagged = new Set<string>();

  constructor(deps: OrphanedWorkSentinelDeps, cfg?: Partial<OrphanedWorkSentinelConfig>) {
    super();
    this.deps = deps;
    this.cfg = { ...DEFAULT_ORPHANED_WORK_SENTINEL_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || !this.cfg.enabled) return;
    this.timer = setInterval(() => { void this.scan(); }, this.cfg.scanIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /**
   * Pure, stateless per-worktree classifier. Returns SKIP unless EVERY orphan
   * gate clears, in this order (cheapest / most-protective first, short-circuit
   * on the first SKIP — never scan mtimes on a live or clean worktree):
   *   1. owner alive            → SKIP (work is in flight; leave it)
   *   2. no uncommitted work    → SKIP (nothing stranded)
   *   3. not settled long enough → SKIP (paused, not abandoned)
   *   else                       → ORPHANED.
   */
  evaluate(info: OrphanedWorktreeInfo): OrphanedWorkEvaluation {
    const skip = (reason: string): OrphanedWorkEvaluation =>
      ({ path: info.path, branch: info.branch, verdict: 'skip', reason });

    if (this.deps.isInUse(info.path)) return skip('owner-alive');
    if (!this.deps.hasUncommittedWork(info.path)) return skip('clean');

    const last = this.deps.lastActivityMs(info.path);
    if (last != null && this.now() - last < this.cfg.settleMs) return skip('active-recently');

    return { path: info.path, branch: info.branch, verdict: 'orphaned', reason: 'uncommitted-owner-dead-settled' };
  }

  /** One scan pass. Records + surfaces (and optionally preserves) orphaned work. */
  async scan(): Promise<{ ts: number; evaluations: OrphanedWorkEvaluation[]; flagged: OrphanedWorkEvent[] }> {
    if (this.running) return { ts: this.now(), evaluations: [], flagged: [] };
    this.running = true;
    const evaluations: OrphanedWorkEvaluation[] = [];
    const flaggedEvents: OrphanedWorkEvent[] = [];
    try {
      let worktrees: OrphanedWorktreeInfo[];
      try { worktrees = this.deps.listWorktrees(); }
      catch { worktrees = []; }

      for (const info of worktrees) {
        const evalResult = this.evaluate(info);
        evaluations.push(evalResult);
        if (evalResult.verdict !== 'orphaned') continue;
        if (flaggedEvents.length >= this.cfg.maxFlagsPerPass) continue;

        const sig = (() => { try { return this.deps.workSignature(info.path); } catch { return 'unknown'; } })();
        const key = `${info.path}::${sig}`;
        if (this.flagged.has(key)) continue; // same stranded state, already surfaced
        this.flagged.add(key);

        const event: OrphanedWorkEvent = {
          ts: this.now(),
          path: info.path,
          branch: info.branch,
          workSig: sig,
          preserved: false,
        };

        if (this.cfg.preserveWork) {
          try { this.deps.preserve(info); event.preserved = true; }
          catch (e) { event.preserveError = e instanceof Error ? e.message : String(e); }
        }

        try { this.deps.record(event); } catch { /* recording must never throw the pass */ }
        try { this.deps.raiseAttention(event); } catch { /* attention must never throw the pass */ }
        this.emit('orphaned-work-detected', event);
        flaggedEvents.push(event);
      }
      this.lastPassAt = this.now();
    } finally {
      this.running = false;
    }
    return { ts: this.now(), evaluations, flagged: flaggedEvents };
  }

  /**
   * Observability snapshot for GET /orphaned-work (read-only — runs one
   * classifier pass over the current worktrees but takes NO action, records
   * nothing, and never preserves).
   */
  snapshot(): {
    enabled: boolean;
    preserveWork: boolean;
    lastPassAt: number;
    settleMs: number;
    evaluations: OrphanedWorkEvaluation[];
    orphanedCount: number;
  } {
    let evaluations: OrphanedWorkEvaluation[] = [];
    try { evaluations = this.deps.listWorktrees().map((info) => this.evaluate(info)); }
    catch { evaluations = []; }
    return {
      enabled: this.cfg.enabled,
      preserveWork: this.cfg.preserveWork,
      lastPassAt: this.lastPassAt,
      settleMs: this.cfg.settleMs,
      evaluations,
      orphanedCount: evaluations.filter((e) => e.verdict === 'orphaned').length,
    };
  }
}

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
import { mapBounded, withDeadline } from './agentWorktreeGit.js';

/**
 * Wall-clock ceiling on ONE scan or snapshot pass — the SIBLING of the reaper's
 * PASS_DEADLINE_MS, added in round four.
 *
 * WHY IT WAS MISSING AND WHY THAT MATTERED. Round three gave the reaper ceilings
 * because `running` and `pendingSnapshot` clear in `finally` blocks, and a
 * `finally` never runs on a promise that never settles. This sentinel has the
 * IDENTICAL structure over the IDENTICAL injectable deps — and got neither. All
 * five round-four reviewers found it independently, and the spec's parity table
 * (which lists seven properties) had no row for the ceiling, so the one dimension
 * where parity actually failed was the one dimension the table did not mention.
 *
 * The consequence here is WORSE than on the reaper: `snapshot()` never rejects, so
 * the route's last-resort `catch` never fires — the request hangs with no response
 * at all and every later caller joins the same never-settling promise. Meanwhile
 * `running` stays true and the background scan stops permanently: a detector whose
 * whole purpose is not losing stranded work, silently finding nothing.
 */
const PASS_DEADLINE_MS = 10 * 60_000;

/**
 * Absolute ceiling on how long one pass may hold its in-flight marker. Mirrors the
 * reaper's constant of the same name and exists for the same reason: the marker
 * normally clears when the work SETTLES (which is what stops passes accumulating),
 * and this is the last-resort release so a pass that never settles at all cannot
 * pin it for the process lifetime.
 */
const LATCH_CEILING_MS = 60 * 60_000;

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
  /** Max concurrent per-worktree evaluations in a read snapshot. Mirrors the reaper's
   *  key so ONE rollback lever ("set it to 1") covers BOTH read routes — previously
   *  this fan-out was a hardcoded 4 and the documented lever did not reach it. */
  snapshotConcurrency?: number;
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
  snapshotConcurrency: 4,
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
  listWorktrees: () => OrphanedWorktreeInfo[] | Promise<OrphanedWorktreeInfo[]>;
  /** True when the worktree has uncommitted or untracked changes (the "work"). */
  hasUncommittedWork: (path: string) => boolean | Promise<boolean>;
  /** A stable short signature of the current dirty state (for episode dedup). */
  workSignature: (path: string) => string | Promise<string>;
  /** True when the worktree is in use: a live session/index lock OR a running
   *  process whose cwd is inside it. The "owner is alive — leave it" signal. */
  /** true = owner alive (skip) · false = idle · 'unknown' = liveness undeterminable.
   *  'unknown' must NOT be collapsed to true here: that would assert an owner this
   *  sentinel never observed, and silently skip every worktree on a failed scan. */
  isInUse: (path: string) => boolean | 'unknown' | Promise<boolean | 'unknown'>;
  /** Most recent file-activity time (ms epoch) inside the worktree, or null when
   *  unknown. Drives the settle gate. */
  lastActivityMs: (path: string) => number | null | Promise<number | null>;
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

/**
 * The `/orphaned-work` read shape.
 *
 * NAMED for the same reason the reaper's was: it had been hand-copied into three
 * declarations that nothing forced to agree, so `undeterminedCount` had to be added
 * to all three by hand. Round five caught that the reaper got this treatment and its
 * sibling did not — the same one-of-two pattern this change keeps producing.
 */
export interface OrphanedWorkSnapshot {
  enabled: boolean;
  preserveWork: boolean;
  lastPassAt: number;
  settleMs: number;
  evaluations: OrphanedWorkEvaluation[];
  orphanedCount: number;
  /** Worktrees whose verdict could not be determined — the per-ITEM honesty count. */
  undeterminedCount: number;
  /**
   * True when ENUMERATION itself failed, so `orphanedCount: 0` means "could not
   * tell", NOT "nothing stranded".
   *
   * WHY IT IS SEPARATE FROM `undeterminedCount`: that count is derived FROM
   * `evaluations`, which is empty when enumeration fails — so it structurally
   * cannot cover this case. Round four fixed exactly this hole on the reaper and
   * left it here, and the parity table gained no row for it: the same
   * one-of-two-consumers mistake, committed inside the fix for a
   * one-of-two-consumers mistake.
   */
  enumerationFailed: boolean;
}

export class OrphanedWorkSentinel extends EventEmitter {
  private readonly cfg: OrphanedWorkSentinelConfig;
  private readonly deps: OrphanedWorkSentinelDeps;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPassAt = 0;
  /** In-flight read snapshot shared by concurrent callers (single-flight, NOT a cache).
   *  Route parity with AgentWorktreeReaper.snapshot() — both read routes had the
   *  identical blocking shape, so both get the identical protections. */
  private pendingSnapshot?: Promise<OrphanedWorkSnapshot>;
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
  async evaluate(info: OrphanedWorktreeInfo): Promise<OrphanedWorkEvaluation> {
    const skip = (reason: string): OrphanedWorkEvaluation =>
      ({ path: info.path, branch: info.branch, verdict: 'skip', reason });

    const live = await this.deps.isInUse(info.path);
    // Distinct reason, deliberately. Reporting 'owner-alive' for an undeterminable scan
    // states a fact we never observed, and renders in the aggregate as "nothing
    // stranded" — the worst answer this surface can give.
    if (live === 'unknown') return skip('owner-liveness-unknown');
    if (live) return skip('owner-alive');
    if (!(await this.deps.hasUncommittedWork(info.path))) return skip('clean');

    const last = await this.deps.lastActivityMs(info.path);
    if (last != null && this.now() - last < this.cfg.settleMs) return skip('active-recently');

    return { path: info.path, branch: info.branch, verdict: 'orphaned', reason: 'uncommitted-owner-dead-settled' };
  }

  /** One scan pass. Records + surfaces (and optionally preserves) orphaned work. */
  async scan(): Promise<{ ts: number; evaluations: OrphanedWorkEvaluation[]; flagged: OrphanedWorkEvent[] }> {
    if (this.running) return { ts: this.now(), evaluations: [], flagged: [] };
    this.running = true;
    // TWO CLOCKS, matching the reaper (round six). The caller is freed at
    // PASS_DEADLINE_MS; `running` is held until the work actually SETTLES, so a
    // persistent wedge cannot accumulate live passes. This sentinel takes no
    // destructive action, so the motivation here is resource cost rather than delete
    // safety — but leaving it on the single clock is what made the spec's
    // cancellation claim ("abandoned-client cost is capped at ONE pass") false.
    const work = this.scanPass();
    void withDeadline(work, LATCH_CEILING_MS, 'orphaned-work scan latch')
      .catch(() => { /* the caller arm reports; this arm only frees the latch */ })
      .finally(() => { this.running = false; });
    try {
      return await withDeadline(work, PASS_DEADLINE_MS, 'orphaned-work scan pass');
    } catch {
      // Report an EMPTY pass — for a DETECTOR that means "flagged nothing this
      // round", the non-acting direction — rather than staying wedged. The abandoned
      // pass still cannot be cancelled; what it can no longer do is be joined by a
      // second one.
      return { ts: this.now(), evaluations: [], flagged: [] };
    }
  }

  private async scanPass(): Promise<{ ts: number; evaluations: OrphanedWorkEvaluation[]; flagged: OrphanedWorkEvent[] }> {
    const evaluations: OrphanedWorkEvaluation[] = [];
    const flaggedEvents: OrphanedWorkEvent[] = [];
    {
      let worktrees: OrphanedWorktreeInfo[];
      try { worktrees = await this.deps.listWorktrees(); }
      catch { worktrees = []; }

      for (const info of worktrees) {
        const evalResult = await this.evaluate(info);
        evaluations.push(evalResult);
        if (evalResult.verdict !== 'orphaned') continue;
        if (flaggedEvents.length >= this.cfg.maxFlagsPerPass) continue;

        const sig = await (async () => { try { return await this.deps.workSignature(info.path); } catch { return 'unknown'; } })();
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
    }
    return { ts: this.now(), evaluations, flagged: flaggedEvents };
  }

  /**
   * Observability snapshot for GET /orphaned-work (read-only — runs one
   * classifier pass over the current worktrees but takes NO action, records
   * nothing, and never preserves).
   */
  async snapshot(): Promise<OrphanedWorkSnapshot> {
    if (this.pendingSnapshot) return this.pendingSnapshot;
    // The deadline is what makes the `.finally()` below REACHABLE — see
    // PASS_DEADLINE_MS. Without it one non-settling injected signal pins
    // `pendingSnapshot` for the process lifetime and every later `/orphaned-work`
    // caller joins a promise that never resolves.
    const work = this.snapshotUncoalesced();
    void withDeadline(work, LATCH_CEILING_MS, 'orphaned-work snapshot latch')
      .catch(() => { /* the caller arm reports; this arm only frees the marker */ })
      .finally(() => { if (this.pendingSnapshot === run) this.pendingSnapshot = undefined; });
    const run = withDeadline(work, PASS_DEADLINE_MS, 'orphaned-work snapshot pass');
    this.pendingSnapshot = run;
    return run;
  }

  private async snapshotUncoalesced(): Promise<OrphanedWorkSnapshot> {
    let evaluations: OrphanedWorkEvaluation[] = [];
    let enumerationFailed = false;
    try {
      const infos = await this.deps.listWorktrees();
      // Bounded, not Promise.all: same reason as the reaper's snapshot — freeing
      // the event loop must not instead spawn one git child per worktree at once.
      // Per-item catch, mirroring the reaper. Without it ONE rejecting worktree collapses
      // the whole response to `evaluations: []`, and the route answers "nothing stranded"
      // BECAUSE it failed — the single worst answer for a surface whose entire purpose is
      // not losing stranded work.
      evaluations = await mapBounded(infos, this.cfg.snapshotConcurrency ?? 4, async (info) => {
        try { return await this.evaluate(info); }
        catch {
          return { path: info.path, branch: info.branch ?? null, verdict: 'skip' as const, reason: 'eval-error' };
        }
      });
    }
    catch (err) {
      // Enumeration failed, so `orphanedCount: 0` below means "could not tell", not
      // "nothing stranded" — the single worst answer for a surface whose entire
      // purpose is not losing stranded work, which the per-ITEM catch a few lines
      // above says in exactly those words while this outer one did it anyway.
      enumerationFailed = true;
      this.emit('error', err);
    }
    return {
      enabled: this.cfg.enabled,
      preserveWork: this.cfg.preserveWork,
      lastPassAt: this.lastPassAt,
      settleMs: this.cfg.settleMs,
      evaluations,
      orphanedCount: evaluations.filter((e) => e.verdict === 'orphaned').length,
      undeterminedCount: evaluations.filter(
        (e) => e.reason === 'owner-liveness-unknown' || e.reason === 'eval-error',
      ).length,
      enumerationFailed,
    };
  }
}

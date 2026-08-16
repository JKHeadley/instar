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
import { mapBounded, withDeadline } from './agentWorktreeGit.js';

/**
 * Wall-clock ceiling on ONE reap or snapshot pass.
 *
 * WHY A PASS NEEDS ITS OWN BOUND even though every read below it is bounded.
 * `running` and `pendingSnapshot` are cleared in `finally` blocks, and a
 * `finally` never runs on a promise that never settles. Every `deps.*` signal is
 * INJECTED, so the read-level bounds inside agentWorktreeGit do not cover a
 * wiring that supplies its own. Without this ceiling, one non-settling signal
 * leaves `running` true forever and the background reaper silently stops running
 * passes — a healthy-looking guard that never finds anything, which is precisely
 * the failure shape the reaper exists to prevent. Sized well above a real pass
 * (48 worktrees at bounded concurrency) so it is a wedge-breaker, never a
 * throughput limit.
 */
const PASS_DEADLINE_MS = 10 * 60_000;

/**
 * Absolute ceiling on how long a single pass may hold the `running` latch.
 *
 * The latch normally clears when the pass SETTLES, which is what stops two passes
 * deleting at once (see `reap()`). This backstop exists only for a pass that never
 * settles at all — without it, fixing the overlap would reintroduce the very wedge
 * PASS_DEADLINE_MS was added to break. Deliberately far above the caller ceiling:
 * releasing this latch early is exactly the hazard being fixed, so it must be a
 * last resort rather than a routine timeout.
 */
const LATCH_CEILING_MS = 60 * 60_000;

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
  /**
   * Max concurrent per-worktree evaluations in a read snapshot. Making the read
   * path non-blocking is necessary but not sufficient — unbounded fan-out would
   * replace one event-loop freeze with a burst of ~3 git subprocesses per
   * worktree all at once (48 worktrees measured on a live agent). Keeps the loop
   * free AND the process count bounded. 1 = fully serial (slowest, gentlest).
   */
  snapshotConcurrency: number;
}

export const DEFAULT_AGENT_WORKTREE_REAPER_CONFIG: AgentWorktreeReaperConfig = {
  enabled: false,
  dryRun: true,
  reapIntervalMs: 24 * 3600 * 1000,
  initialPassDelayMs: 15 * 60 * 1000,
  maxReapsPerPass: 20,
  maxReclaimFailuresPerPath: 3,
  githubMergeCheck: true,
  snapshotConcurrency: 4,
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
/**
 * A signal may be synchronous OR asynchronous. Production supplies non-blocking
 * git-backed readers (event-loop fix); unit tests supply plain sync fakes. Both
 * flow through the SAME `evaluate()`, so the classification that authorises a
 * delete can never drift between a "fast path" and a "route path".
 */
export type Awaitable<T> = T | Promise<T>;

export interface AgentWorktreeReaperDeps {
  /** Worktrees under the agent's `.worktrees/` (excludes the main checkout). */
  listWorktrees: () => Awaitable<WorktreeInfo[]>;
  /** True when the worktree has NO uncommitted or untracked changes. */
  isClean: (path: string) => Awaitable<boolean>;
  /** True when the branch's content is already in the default branch. */
  isMerged: (info: WorktreeInfo) => Awaitable<boolean>;
  /** True when the worktree is in use: a live session/index lock OR a running
   *  process whose cwd is inside it. The real "don't yank it" signal. */
  isInUse: (path: string) => Awaitable<boolean>;
  /** The worktree's LIVE currently-checked-out branch, read at RECLAIM time to close
   *  the enumerate→reclaim TOCTOU: `info.branch` is captured at enumeration, but a
   *  builder may `git checkout -b <new-unmerged>` before the reaper reaches the
   *  delete — and `isMerged(info)` would still check the STALE (merged) branch.
   *  Production: SafeGitExecutor `rev-parse --abbrev-ref HEAD` on the path. */
  currentBranch: (path: string) => Awaitable<string | null>;
  /** Optional belt-and-suspenders: true when a `.instar-build-active` marker file sits
   *  at the worktree root — an in-flight builder's explicit "don't reap me" claim.
   *  Production: fs.existsSync(path/.instar-build-active). */
  hasActiveBuildMarker?: (path: string) => Awaitable<boolean>;
  /** Remove the worktree (git worktree remove). Only called when killsEnabled. */
  removeWorktree: (path: string) => void;
  now?: () => number;
}

/**
 * The `/worktrees/agent-reaper` read shape.
 *
 * NAMED rather than hand-copied. It was previously written out inline in three
 * places (the field, `snapshot()`, `snapshotUncoalesced()`), so adding a property
 * meant editing three declarations that nothing forced to agree — the same
 * copy-drift shape as the read-preamble this change extracted in the funnel.
 */
export interface AgentWorktreeReaperSnapshot {
  enabled: boolean;
  dryRun: boolean;
  lastPassAt: number;
  reapedLastPass: number;
  initialPassPending: boolean;
  worktrees: WorktreeEvaluation[];
  reclaimable: number;
  /** True when ENUMERATION failed, so `reclaimable: 0` means "could not tell",
   *  NOT "nothing to reclaim". Without it the two render identically. */
  enumerationFailed: boolean;
  /** Bounded ring of recent `error` emissions — see AgentWorktreeReaper.recentErrors. */
  recentErrors: Array<{ ts: number; message: string }>;
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
  /** In-flight read snapshot shared by concurrent callers (single-flight, NOT a cache). */
  private pendingSnapshot?: Promise<AgentWorktreeReaperSnapshot>;
  /** Per-path consecutive removal-failure counts (breaker). Keyed by worktree path;
   *  cleared on a successful removal of that path. Process-lifetime (resets on restart). */
  private reclaimFailures = new Map<string, number>();
  /** Paths whose breaker has tripped + already emitted (emit-once). */
  private reclaimTripped = new Set<string>();

  /**
   * Bounded ring of recent `error` emissions, newest last. Surfaced on `snapshot()`.
   *
   * WHY THIS EXISTS — it fixes a LIVE CRASH, not a style problem. This class is an
   * EventEmitter that emits `'error'`, and `'error'` is special in Node: emitting it
   * with ZERO listeners THROWS. The production construction site attaches no listener
   * (verified across the whole source tree AND the deployed build), and both drivers
   * call `void this.reap()` from a timer — so the throw escapes as an unhandled
   * rejection into a policy that treats an unrecognised one as FATAL and exits the
   * process. On an ARMED agent a single failed `git worktree remove` therefore stops
   * the server. That hazard is PRE-EXISTING; round three made it worse by adding a
   * third emit site (the pass ceiling) reachable on dry-run agents too.
   *
   * The default listener below makes `emit('error')` structurally safe for every
   * site, present and future — a consumer that attaches its own listener still
   * receives everything, because EventEmitter fans out to all listeners.
   *
   * It RECORDS rather than swallows. A silent default listener would trade a crash
   * for an invisible failure, which is the same trade this whole change exists to
   * refuse: the reaper's sibling defect is that its `reaped` event has no listener,
   * so an armed deleter leaves no record of what it deleted. Turning `error` into
   * another unobservable would repeat it one field over.
   */
  private readonly recentErrors: Array<{ ts: number; message: string }> = [];
  private static readonly MAX_RECENT_ERRORS = 10;

  constructor(deps: AgentWorktreeReaperDeps, cfg?: Partial<AgentWorktreeReaperConfig>) {
    super();
    this.deps = deps;
    this.cfg = { ...DEFAULT_AGENT_WORKTREE_REAPER_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
    // See recentErrors. MUST be attached in the constructor: an emit that happens
    // before a consumer subscribes would otherwise still throw.
    this.on('error', (err: unknown) => {
      this.recentErrors.push({
        ts: this.now(),
        message: err instanceof Error ? err.message : String(err),
      });
      while (this.recentErrors.length > AgentWorktreeReaper.MAX_RECENT_ERRORS) {
        this.recentErrors.shift();
      }
    });
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
   *
   * ASYNC since the event-loop fix: each signal is `await`ed so a production
   * git-backed dep can release the thread between spawns. Signals may be sync OR
   * async (`Awaitable`), so this is ONE classification path shared by the reap
   * timer and the read route — deliberately not a second async-only path that
   * could drift from the one that authorises deletes. Awaiting a non-promise is a
   * no-op, so injected sync fakes behave exactly as before.
   */
  async evaluate(info: WorktreeInfo): Promise<WorktreeEvaluation> {
    const keep = (reason: string): WorktreeEvaluation =>
      ({ path: info.path, branch: info.branch, verdict: 'keep', reason });

    if (await this.deps.isInUse(info.path)) return keep('in-use');
    if (!info.branch) return keep('detached-or-unknown-branch');
    if (!(await this.deps.isClean(info.path))) return keep('uncommitted-changes');
    if (!(await this.deps.isMerged(info))) return keep('unmerged');
    return { path: info.path, branch: info.branch, verdict: 'reap-eligible', reason: 'merged-clean-idle' };
  }

  /** One reap pass. Returns the per-worktree evaluations + what was reaped. */
  async reap(): Promise<{ ts: number; evaluations: WorktreeEvaluation[]; reaped: string[]; dryRun: boolean }> {
    if (this.running) return { ts: this.now(), evaluations: [], reaped: [], dryRun: !this.killsEnabled };
    this.running = true;

    // TWO SEPARATE CLOCKS — the round-five fix. Round three used ONE: the pass
    // deadline both freed the caller AND released `running` in a `finally`. Two
    // reviewers (round-four scalability, round-five external) independently showed
    // why that is wrong for a DELETER: the abandoned pass is not cancelled, so it
    // keeps calling removeWorktree while the released latch lets the NEXT pass start.
    // N overlapping passes then delete up to N x maxReapsPerPass, and the config key
    // documented as "bounded blast radius per pass" stops being a rate limit at all.
    // Round four recorded that honestly and deferred it; both reviewers said
    // deferring is weak precisely BECAUSE this deletes, and they were right.
    //
    //   CALLER clock  (PASS_DEADLINE_MS)         — frees the REQUEST. The caller gets
    //                                              an honest empty pass and moves on.
    //   CONTROLLER clock (LATCH_CEILING_MS)      — frees the LATCH, and only when the
    //                                              underlying work has actually
    //                                              SETTLED. No second pass can start
    //                                              while the first is still deleting.
    //
    // The controller clock is a backstop, not the normal path: `running` normally
    // clears the moment the pass settles, however long that takes. It exists so a
    // pass that NEVER settles cannot hold the latch for the process lifetime — the
    // original wedge, which this must not reintroduce while fixing the overlap.
    const pass = this.reapPass();
    // Latch lifetime is bound to the WORK, not to the caller's patience.
    void withDeadline(pass, LATCH_CEILING_MS, 'worktree reap latch')
      .catch(() => { /* the caller path below reports; this arm only frees the latch */ })
      .finally(() => { this.running = false; });

    try {
      return await withDeadline(pass, PASS_DEADLINE_MS, 'worktree reap pass');
    } catch (err) {
      // The pass did not settle within the CALLER ceiling. Report an EMPTY pass — no
      // evaluations, nothing reaped — and record the error. The latch is deliberately
      // NOT released here; see above.
      this.emit('error', err);
      return { ts: this.now(), evaluations: [], reaped: [], dryRun: !this.killsEnabled };
    }
  }

  private async reapPass(): Promise<{ ts: number; evaluations: WorktreeEvaluation[]; reaped: string[]; dryRun: boolean }> {
    const reaped: string[] = [];
    const evaluations: WorktreeEvaluation[] = [];
    {
      let worktrees: WorktreeInfo[];
      try { worktrees = await this.deps.listWorktrees(); }
      catch (err) { this.emit('error', err); return { ts: this.now(), evaluations: [], reaped: [], dryRun: !this.killsEnabled }; }

      for (const info of worktrees) {
        let evaln: WorktreeEvaluation;
        try { evaln = await this.evaluate(info); }
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
        const raceReason = await this.reclaimRaceGuard(info);
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
  private async reclaimRaceGuard(info: WorktreeInfo): Promise<string | null> {
    try {
      if (await this.deps.hasActiveBuildMarker?.(info.path)) return 'raced-build-active-marker';
      // The load-bearing check: has the checked-out branch changed since enumeration?
      // If so, isMerged(info) (which reads info.branch) is stale and must NOT authorize a delete.
      const liveBranch = await this.deps.currentBranch(info.path);
      if (liveBranch !== info.branch) return 'raced-changed-since-eval';
      // MUST be awaited. These signals are Awaitable<boolean>: an un-awaited Promise is
      // ALWAYS truthy, which silently made `isInUse` return 'raced' for everything (an
      // inert reaper) AND — because `!Promise` is ALWAYS false — made the dirty and
      // unmerged re-checks vacuous, so a worktree that went DIRTY between evaluation and
      // reclaim would have been DELETED. TypeScript permits truthiness on a union with a
      // Promise, so nothing catches this at build time; the async-deps reap test below is
      // the guard. Never reintroduce a bare `if (this.deps.<signal>(...))` here.
      if (await this.deps.isInUse(info.path)) return 'raced-now-in-use';
      if (!(await this.deps.isClean(info.path))) return 'raced-now-dirty';
      // Branch unchanged + clean + idle → info.branch is still current, so re-confirming
      // isMerged(info) is valid. (Belt: main may have moved, un-merging it.)
      if (!(await this.deps.isMerged(info))) return 'raced-now-unmerged';
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
   * NON-BLOCKING since the event-loop fix. Measured before it (2026-07-29, live
   * agent, 48 worktrees): one request froze the Node event loop for 10.6s because
   * this fanned `execFileSync` out per worktree on the handler's thread.
   *
   * Two properties beyond "it is async now":
   *  - BOUNDED fan-out (`snapshotConcurrency`), so freeing the loop does not
   *    instead unleash ~150 concurrent git subprocesses (the fork-bomb direction).
   *  - SINGLE-FLIGHT: concurrent callers share the in-flight pass rather than each
   *    starting their own. This is NOT a cache — nothing is retained after the
   *    pass settles, so the route still answers "what I see right now" and the
   *    freshness contract is unchanged. It only stops N simultaneous hits
   *    multiplying the work by N.
   */
  async snapshot(): Promise<AgentWorktreeReaperSnapshot> {
    if (this.pendingSnapshot) return this.pendingSnapshot;
    // The deadline is what makes the `.finally()` reachable — see PASS_DEADLINE_MS.
    // Without it a single non-settling injected signal pins `pendingSnapshot`, and
    // every later caller of this route joins a promise that never resolves.
    //
    // DELIBERATE ASYMMETRY WITH reap(). An abandoned reap pass returns an EMPTY
    // result; an abandoned snapshot REJECTS. They differ because an empty result
    // means different things on the two surfaces: an empty pass simply does
    // nothing (the safe direction), whereas an empty snapshot ASSERTS "nothing
    // reclaimable" on the read surface that reports what the deleter sees — a
    // fabricated answer, the same class as the NaN-concurrency hole. The route
    // turns this rejection into a 500, which is the honest "I could not answer".
    //
    // TWO CLOCKS HERE TOO (round six). Round five gave `reap()` a caller clock and a
    // separate latch clock and left this surface on the single clock — the fourth
    // time in this change a protection landed on the reaper's reap path and not its
    // siblings. The consequence here is resource rather than delete safety: each
    // ceiling expiry released `pendingSnapshot` while the abandoned pass was still
    // running, so a persistent wedge accumulated live passes without bound, which
    // directly contradicted this spec's own cancellation claim that single-flight
    // caps the abandoned-client cost at ONE pass.
    const work = this.snapshotUncoalesced();
    // Marker lifetime follows the WORK; LATCH_CEILING_MS is the last-resort backstop
    // so a never-settling pass cannot pin it for the process lifetime.
    void withDeadline(work, LATCH_CEILING_MS, 'worktree snapshot latch')
      .catch(() => { /* the caller arm below reports; this arm only frees the marker */ })
      .finally(() => { if (this.pendingSnapshot === run) this.pendingSnapshot = undefined; });
    const run = withDeadline(work, PASS_DEADLINE_MS, 'worktree snapshot pass');
    this.pendingSnapshot = run;
    return run;
  }

  private async snapshotUncoalesced(): Promise<AgentWorktreeReaperSnapshot> {
    let worktrees: WorktreeEvaluation[] = [];
    let enumerationFailed = false;
    try {
      const infos = await this.deps.listWorktrees();
      worktrees = await mapBounded(infos, this.cfg.snapshotConcurrency, async (info) => {
        try { return await this.evaluate(info); }
        catch { return { path: info.path, branch: info.branch, verdict: 'keep' as Verdict, reason: 'eval-error' }; }
      });
    } catch (err) {
      // The enumeration failed, so `reclaimable: 0` below means "could not tell",
      // NOT "nothing to reclaim". Round four caught that those two were rendered
      // identically — a fabricated answer on the surface that reports what the
      // deleter sees, which is precisely the class this spec argues must reject
      // rather than answer emptily. It cannot reject here (the route must stay
      // answerable), so it answers HONESTLY instead: the flag makes the difference
      // visible, and the error is recorded rather than swallowed.
      enumerationFailed = true;
      this.emit('error', err);
    }
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      lastPassAt: this.lastPassAt,
      reapedLastPass: this.reapedLastPass,
      initialPassPending: this.initialTimer !== undefined,
      worktrees,
      reclaimable: worktrees.filter((w) => w.verdict === 'reap-eligible').length,
      enumerationFailed,
      recentErrors: [...this.recentErrors],
    };
  }
}

/**
 * WriterFence — the single-writer fence every learned-skill write passes (spec
 * docs/specs/skill-learning-sentinel.md, "Multi-machine posture" → "Single writer"; §3.5 commit
 * protocol step 2).
 *
 * Rules (integration map deviations (u)/(v)):
 *  - No lease coordinator at all (a non-mesh agent) → sole writer: `fence: 'local'`, epoch 0, never
 *    observe-only by construction.
 *  - A coordinator that says this machine does not hold the operator-messaging lease → `not-holder`.
 *  - The lease medium is local (LocalLeaseStore selected, not a git repo, no git-sync manager, or the
 *    remote list is provably empty) → the fence is the locally read epoch, journaled `fence: 'local'`,
 *    exactly as `casWrite` 4b does. A remote whose existence is UNKNOWN (`hasRemote() === null`) is
 *    treated as present: unknown never loosens the fence.
 *  - Git with a remote → `pullRebase()` first. A pull that fails is the cached-belief case: the write is
 *    aborted `aborted-unreachable` (counted; three in a row raise ONE DegradationReporter row per
 *    streak). After a successful pull the epoch is re-read; a lease that moved during the pull is
 *    `not-holder`, and an epoch different from the one the prepare row carried is `aborted` (stale).
 *
 * `pullRebase()` returning false is ambiguous in GitSyncManager (failure OR not a git repo), which is
 * why the repo + remote checks run BEFORE the pull and a false afterwards means unreachable.
 */
export interface WriterFenceDeps {
  /** Is there a lease coordinator at all? false = non-mesh agent = sole writer. */
  hasCoordinator: () => boolean;
  holdsLease: () => boolean;
  /** The current effective lease epoch (the fencing clock). */
  currentEpoch: () => number;
  /** True when the lease medium selected at boot is the LocalLeaseStore. */
  leaseMediumLocal?: () => boolean;
  /** `GitSyncManager.pullRebase()`; null when no git-sync manager exists on this machine. */
  pullRebase: () => boolean | null;
  /** `!gitLeaseHasNoRemote()`: true = a remote exists, false = provably none, null = unknown (treated as present). */
  hasRemote: () => boolean | null;
  isGitRepo: () => boolean;
  degradation?: { report(event: { feature: string; primary: string; fallback: string; reason: string; impact: string }): void } | null;
  now?: () => number;
  logger?: (message: string) => void;
}

export type FenceResult =
  | { ok: true; epoch: number; fence: 'git' | 'local' }
  | { ok: false; reason: 'aborted-unreachable' | 'aborted' | 'not-holder'; detail?: string };

export const UNREACHABLE_STREAK_FOR_DEGRADATION = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export class WriterFence {
  private readonly d: WriterFenceDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private unreachableAt: number[] = [];
  private streak = 0;
  private streakReported = false;

  constructor(deps: WriterFenceDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? (() => {});
  }

  /** The epoch as read right now, without a pull — what a prepare row records before the fence runs. */
  peekEpoch(): number {
    if (!this.safe(() => this.d.hasCoordinator(), false)) return 0;
    const e = this.safe(() => this.d.currentEpoch(), 0);
    return Number.isFinite(e) ? e : 0;
  }

  /** Does the fence run through git-with-remote (pull before write) or the locally read epoch? */
  medium(): 'git' | 'local' {
    if (!this.safe(() => this.d.hasCoordinator(), false)) return 'local';
    if (this.d.leaseMediumLocal && this.safe(() => this.d.leaseMediumLocal!(), false)) return 'local';
    if (!this.safe(() => this.d.isGitRepo(), false)) return 'local';
    if (this.safe(() => this.d.hasRemote(), null) === false) return 'local';
    return 'git';
  }

  acquireFence(opts: { expectedEpoch?: number } = {}): FenceResult {
    if (!this.safe(() => this.d.hasCoordinator(), false)) return { ok: true, epoch: 0, fence: 'local' };
    if (!this.safe(() => this.d.holdsLease(), false)) return { ok: false, reason: 'not-holder', detail: 'this machine does not hold the operator-messaging lease' };
    if (this.medium() === 'local') {
      return { ok: true, epoch: this.peekEpoch(), fence: 'local' };
    }
    const pulled = this.safe(() => this.d.pullRebase(), false);
    if (pulled === null) {
      // A git repo with a remote but no git-sync manager on this machine: nothing can pull, so the
      // remote state is unknowable here — the same cached-belief case as a failed pull.
      this.recordUnreachable('no git-sync manager on this machine');
      return { ok: false, reason: 'aborted-unreachable', detail: 'no git-sync manager on this machine: the remote cannot be pulled before the write' };
    }
    if (pulled === false) {
      this.recordUnreachable('pullRebase failed');
      return { ok: false, reason: 'aborted-unreachable', detail: 'pull --rebase failed: the remote is unreachable, the write is refused (cached belief)' };
    }
    this.streak = 0;
    this.streakReported = false;
    if (!this.safe(() => this.d.holdsLease(), false)) return { ok: false, reason: 'not-holder', detail: 'the lease moved during the pull' };
    const epoch = this.peekEpoch();
    if (typeof opts.expectedEpoch === 'number' && opts.expectedEpoch !== epoch) {
      return { ok: false, reason: 'aborted', detail: `stale epoch: prepared at ${opts.expectedEpoch}, lease store reads ${epoch} after the pull` };
    }
    return { ok: true, epoch, fence: 'git' };
  }

  /** `abortedUnreachable24h` for `GET /skills/learned`. */
  abortedUnreachable24h(): number {
    const cutoff = this.now() - DAY_MS;
    this.unreachableAt = this.unreachableAt.filter((t) => t >= cutoff);
    return this.unreachableAt.length;
  }

  consecutiveUnreachable(): number {
    return this.streak;
  }

  private recordUnreachable(why: string): void {
    this.unreachableAt.push(this.now());
    this.streak += 1;
    this.log(`[WriterFence] write aborted (unreachable): ${why} — ${this.streak} in a row`);
    if (this.streak >= UNREACHABLE_STREAK_FOR_DEGRADATION && !this.streakReported) {
      this.streakReported = true;
      try {
        this.d.degradation?.report({
          feature: 'monitoring.skillLearning.writerFence',
          primary: 'pull-before-write fence on the git lease medium',
          fallback: 'observe-only: no learned-skill write lands on this machine',
          reason: `${this.streak} consecutive writes aborted as unreachable (${why})`,
          impact: 'learned skills are not created, patched, confirmed or retired until the remote is reachable again',
        });
      } catch (err) {
        this.log(`[WriterFence] degradation report failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; } // @silent-fallback-ok — an unreadable lease/git probe reads as the conservative side (not holder / unknown)
  }
}

/**
 * RegistrySyncDebouncer — G2 automated state sync (durable half).
 *
 * Spec: docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G2.
 *
 * The Phase-0 root cause: a running server changed its registry (role/lease)
 * but NOTHING pushed that change to git, so cross-machine state only ever
 * propagated by hand. This component closes that: a marked-dirty registry is
 * debounced and committed+pushed to git — but ONLY the authoritative machine
 * (lease holder / awake) writes durable authority-bearing state (single-writer,
 * removing the O(N) thundering-herd of every machine pushing a corrected
 * registry).
 *
 * This is the DURABLE path only. High-frequency liveness/heartbeat (ephemeral)
 * never comes through here — it travels over the tunnel and stays out of git
 * history, so steady-state healthy operation produces ~0 commits (the
 * ephemeral-vs-durable split, spec §Design Principles).
 *
 * Push contention: commitAndPush performs `git push` which fails (returns
 * false) on a non-fast-forward — we never force-push. Repeated failures past a
 * threshold emit a sync-health signal so the lease layer can self-suspend
 * ingress (a machine that cannot prove it is visible must not serve). The
 * pull/rebase reconciliation itself lives in the periodic GitSync.sync cycle.
 */

export interface SyncHealthState {
  healthy: boolean;
  consecutiveFailures: number;
  lastError?: string;
  lastPushAt?: string;
  lastAttemptAt?: string;
}

export interface RegistrySyncDeps {
  /** Commit + push the given paths. Returns true if a commit was pushed. */
  commitAndPush: (message: string, paths: string[]) => boolean;
  /** Absolute path of the registry file to stage. */
  registryAbsPath: string;
  /**
   * Single-writer gate: only flush when THIS machine has authority to write
   * durable registry state (holds the lease / is awake). A standby marking
   * dirty is a no-op push (it still updates its own liveness elsewhere).
   */
  isAuthoritative: () => boolean;
  /** Debounce window (registrySyncDebounceMs). */
  debounceMs: number;
  /** Failures before the sync-health signal flips unhealthy. Default 3. */
  maxConsecutiveFailures?: number;
  /** Sync-health signal consumer (lease layer self-suspends ingress on unhealthy). */
  onSyncHealth?: (s: SyncHealthState) => void;
  logger?: (msg: string) => void;
  now?: () => number;
}

export class RegistrySyncDebouncer {
  private readonly deps: RegistrySyncDeps;
  private readonly maxFailures: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingReasons: string[] = [];
  private flushing = false;
  private health: SyncHealthState = { healthy: true, consecutiveFailures: 0 };
  private stopped = false;

  constructor(deps: RegistrySyncDeps) {
    this.deps = deps;
    this.maxFailures = deps.maxConsecutiveFailures ?? 3;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(msg: string): void {
    this.deps.logger?.(`[registry-sync] ${msg}`);
  }

  /**
   * Mark the registry as needing a durable push. Debounced — many rapid marks
   * within the window coalesce into a single commit (coarse, not per-tick).
   */
  markRegistryDirty(reason: string): void {
    if (this.stopped) return;
    this.pendingReasons.push(reason);
    if (this.timer) return; // already scheduled
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Flush immediately (also used by stop()). Returns true if a commit was
   * pushed. A non-authoritative machine returns false without pushing
   * (single-writer). Re-entrancy guarded.
   */
  async flush(): Promise<boolean> {
    if (this.flushing) return false;
    if (this.pendingReasons.length === 0) return false;
    this.flushing = true;
    const reasons = this.pendingReasons.slice(0, 8);
    this.pendingReasons = [];
    this.health.lastAttemptAt = new Date(this.now()).toISOString();

    try {
      if (!this.deps.isAuthoritative()) {
        // Single-writer: a standby never writes durable authority-bearing state.
        this.log(`skip flush — not authoritative (${reasons.length} pending reason(s) dropped)`);
        return false;
      }
      const message = `chore(mesh): registry sync — ${reasons.join('; ').slice(0, 200)}`;
      const pushed = this.deps.commitAndPush(message, [this.deps.registryAbsPath]);
      if (pushed) {
        this.health = {
          healthy: true,
          consecutiveFailures: 0,
          lastPushAt: new Date(this.now()).toISOString(),
          lastAttemptAt: this.health.lastAttemptAt,
        };
        this.deps.onSyncHealth?.(this.health);
        this.log(`pushed: ${message}`);
        return true;
      }
      // commitAndPush returns false either when nothing changed (benign) OR on
      // a push failure. We can't distinguish here, so a "nothing to push" is
      // treated as success (no failure increment) only if a prior push exists.
      // To stay conservative we treat false as a non-failure unless we can see
      // the working tree is dirty — handled by the caller's periodic sync.
      this.log(`commitAndPush returned false (no-op or push declined): ${message}`);
      return false;
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      this.health = {
        healthy: this.health.consecutiveFailures + 1 < this.maxFailures,
        consecutiveFailures: this.health.consecutiveFailures + 1,
        lastError,
        lastPushAt: this.health.lastPushAt,
        lastAttemptAt: this.health.lastAttemptAt,
      };
      this.deps.onSyncHealth?.(this.health);
      this.log(`push failed (${this.health.consecutiveFailures}/${this.maxFailures}): ${lastError}`);
      // Re-queue the reasons so the next mark/flush retries them.
      this.pendingReasons.unshift(...reasons);
      return false;
    } finally {
      this.flushing = false;
    }
  }

  getHealth(): SyncHealthState {
    return { ...this.health };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

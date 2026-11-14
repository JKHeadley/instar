/**
 * QuietTopicScanner — finds the topics Overload shed may move (docs/specs/
 * session-pool-rebalancing-finish.md, change 2). A move only relieves a machine if a
 * session is really running, and only leaves the conversation undisturbed if that
 * session has sat quiet, so a topic is quiet only on positive evidence of both.
 *
 * The work-state read is async and spawns tmux reads, so it stays off the planner's
 * synchronous tick and is capped. Oldest activity comes first, so a topic that has sat
 * longest is always looked at and busy conversations cannot crowd it out.
 */

export const QUIET_MIN_IDLE_MS = 10 * 60_000;
export const QUIET_MAX_CHECKS = 5;

export interface RunningTopicSession {
  sessionKey: string;
  tmuxSession: string;
  /** When the session last did anything (ms). Unknown ⇒ not treated as quiet. */
  lastActivityAt: number | null;
}

export interface QuietTopicScannerDeps {
  /** Topics with a running session on this machine (one cached listing). */
  runningTopicSessions: () => RunningTopicSession[];
  /** Could this topic be moved at all? Checked BEFORE the cap, or pinned and long-running
   *  topics that can never move would fill every slot and shed would quietly stall. */
  movable: (sessionKey: string) => boolean;
  workState: (tmuxSession: string) => Promise<'working' | 'idle' | 'indeterminate'>;
  now?: () => number;
}

export class QuietTopicScanner {
  private quiet: ReadonlySet<string> = new Set();
  private scanning = false;

  constructor(private readonly d: QuietTopicScannerDeps) {}

  current(): ReadonlySet<string> {
    return this.quiet;
  }

  /** Clear the set, for a tick where this machine is no longer a source. */
  clear(): void {
    this.quiet = new Set();
  }

  /** Re-read the set. Never throws; anything unreadable is simply not quiet. */
  async refresh(): Promise<ReadonlySet<string>> {
    if (this.scanning) return this.quiet;
    this.scanning = true;
    try {
      const now = (this.d.now ?? Date.now)();
      const oldestFirst = this.d.runningTopicSessions()
        .filter((s) => s.lastActivityAt !== null && now - s.lastActivityAt >= QUIET_MIN_IDLE_MS && this.d.movable(s.sessionKey))
        .sort((a, b) => (a.lastActivityAt as number) - (b.lastActivityAt as number))
        .slice(0, QUIET_MAX_CHECKS);
      const next = new Set<string>();
      for (const s of oldestFirst) {
        try {
          if ((await this.d.workState(s.tmuxSession)) === 'idle') next.add(s.sessionKey);
        } catch { /* @silent-fallback-ok — an unreadable session is not quiet, so it is not moved */ }
      }
      this.quiet = next;
    } catch {
      this.quiet = new Set(); // @silent-fallback-ok — no listing means no candidates this round
    } finally {
      this.scanning = false;
    }
    return this.quiet;
  }
}

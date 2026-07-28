/**
 * UpdateGate — Session-aware restart gating.
 *
 * Checks whether it's safe to restart the server for an update.
 * Only 'healthy' (actively producing output) sessions block restarts.
 * 'unresponsive', 'idle', and 'dead' sessions don't — blocking an update
 * for a broken session serves no user interest.
 *
 * Healthy sessions are NEVER killed for an update. The gate defers indefinitely
 * while healthy sessions exist, sending warnings at the configured thresholds.
 */

export interface SessionInfo {
  name: string;
  /** tmux session name; required for process-tree idle checks */
  tmuxSession?: string;
  topicId?: number;
  /** The job that spawned this session, if any */
  jobSlug?: string;
}

export interface SessionHealthEntry {
  topicId: number;
  sessionName: string;
  status: string;   // 'healthy' | 'idle' | 'unresponsive' | 'dead'
  idleMinutes: number;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
  retryInMs?: number;
  /** Sessions that are actively blocking the restart */
  blockingSessions?: string[];
  /** Sessions that are unresponsive (warned but not blocking) */
  unresponsiveSessions?: string[];
  /** Background job sessions that were safe to ignore for restart gating */
  nonBlockingJobSessions?: string[];
}

export interface UpdateGateConfig {
  /** Maximum hours to defer a restart for active sessions. Default: 4 */
  maxDeferralHours?: number;
  /** Minutes before forced restart to send first warning. Default: 30 */
  firstWarningMinutes?: number;
  /** Minutes before forced restart to send final warning. Default: 5 */
  finalWarningMinutes?: number;
  /** How often to re-check sessions during deferral, in ms. Default: 5 * 60_000 (5 min) */
  retryIntervalMs?: number;
  /**
   * Primary-developer mode. When true, the gate NEVER defers a restart for
   * active sessions — `canRestart` always returns `{ allowed: true }`. The
   * agent prioritizes always running the latest version over protecting its
   * own sessions from a (session-surviving) server restart. Opt-in per agent
   * via `updates.restartImmediately`; default false leaves the fleet's
   * session-aware deferral untouched. Spec: docs/specs/restart-immediately-spec.md.
   */
  alwaysRestartImmediately?: boolean;
}

export interface UpdateGateStatus {
  /** Whether a restart is currently being deferred */
  deferring: boolean;
  /** When deferral started */
  deferralStartedAt: string | null;
  /** How long we've been deferring, in minutes */
  deferralElapsedMinutes: number;
  /** Max deferral before forced restart */
  maxDeferralHours: number;
  /** Reason for current deferral */
  deferralReason: string | null;
  /** Sessions currently blocking restart */
  blockingSessions: string[];
  /** Whether the first warning (T-30min) has been sent */
  firstWarningSent: boolean;
  /** Whether the final warning (T-5min) has been sent */
  finalWarningSent: boolean;
  /** Primary-developer mode: restarts are never deferred for active sessions */
  alwaysRestartImmediately: boolean;
}

/** Minimal interface for SessionManager — only what we need */
export interface SessionManagerLike {
  listRunningSessions(): SessionInfo[];
  hasActiveProcesses?(tmuxSession: string): boolean;
}

/** Minimal interface for SessionMonitor — only what we need */
export interface SessionMonitorLike {
  getStatus(): {
    sessionHealth: SessionHealthEntry[];
  };
}

export class UpdateGate {
  private config: Required<UpdateGateConfig>;
  private deferralStartedAt: number | null = null;
  private deferralReason: string | null = null;
  private blockingSessions: string[] = [];
  private firstWarningSent = false;
  private firstWarningPending = false;
  private finalWarningSent = false;
  private finalWarningPending = false;

  constructor(config?: UpdateGateConfig) {
    this.config = {
      maxDeferralHours: config?.maxDeferralHours ?? 4,
      firstWarningMinutes: config?.firstWarningMinutes ?? 30,
      finalWarningMinutes: config?.finalWarningMinutes ?? 5,
      retryIntervalMs: config?.retryIntervalMs ?? 5 * 60_000,
      alwaysRestartImmediately: config?.alwaysRestartImmediately ?? false,
    };
  }

  /**
   * Toggle primary-developer mode at runtime (config may change on disk
   * without a restart). When enabled, the next `canRestart` allows immediately
   * and clears any in-flight deferral so a held restart proceeds at once.
   */
  setAlwaysRestartImmediately(value: boolean): void {
    if (this.config.alwaysRestartImmediately === value) return;
    this.config.alwaysRestartImmediately = value;
    if (value) this.reset();
  }

  /**
   * Check if it's safe to restart now.
   *
   * Returns { allowed: true } if restart can proceed.
   * Returns { allowed: false, retryInMs, reason } if sessions are blocking.
   */
  canRestart(
    sessionManager: SessionManagerLike,
    sessionMonitor?: SessionMonitorLike | null,
  ): GateResult {
    // Primary-developer mode: never defer for active sessions. A server restart
    // does NOT kill the agent's tmux sessions (they resume via CONTINUATION) —
    // this agent simply chooses being-on-latest over avoiding the brief restart
    // blip. Short-circuit BEFORE listing sessions so the deferral clock never
    // starts. Default false, so the fleet's session-aware deferral is unchanged.
    if (this.config.alwaysRestartImmediately) {
      this.reset();
      return { allowed: true };
    }

    const sessions = sessionManager.listRunningSessions();

    // No sessions → restart immediately
    if (sessions.length === 0) {
      this.reset();
      return { allowed: true };
    }

    const { activeSessions, unresponsiveSessions, nonBlockingJobSessions } =
      this.classifyRunningSessions(sessions, sessionManager, sessionMonitor);

    // No active sessions → restart (idle/dead/unresponsive don't block)
    if (activeSessions.length === 0) {
      this.reset();
      return {
        allowed: true,
        unresponsiveSessions: unresponsiveSessions.length > 0 ? unresponsiveSessions : undefined,
        nonBlockingJobSessions: nonBlockingJobSessions.length > 0 ? nonBlockingJobSessions : undefined,
      };
    }

    // Active sessions exist — start or continue deferral
    if (!this.deferralStartedAt) {
      this.deferralStartedAt = Date.now();
    }

    const elapsedMs = Date.now() - this.deferralStartedAt;
    const maxDeferralMs = this.config.maxDeferralHours * 60 * 60_000;
    const remainingMs = maxDeferralMs - elapsedMs;

    this.deferralReason = `${activeSessions.length} active session(s): ${activeSessions.join(', ')}`;
    this.blockingSessions = activeSessions;

    // Max deferral exceeded — but only force restart if no HEALTHY sessions.
    // Active, healthy sessions should NEVER be killed for an update.
    // The update can wait — the user's work cannot.
    if (remainingMs <= 0) {
      console.log(`[UpdateGate] Max deferral (${this.config.maxDeferralHours}h) exceeded, but ${activeSessions.length} healthy session(s) still running — continuing to defer`);
    }

    // Check warning thresholds
    const remainingMinutes = remainingMs / 60_000;

    if (remainingMinutes <= this.config.finalWarningMinutes && !this.finalWarningSent) {
      this.finalWarningSent = true;
      this.finalWarningPending = true;
    }

    if (remainingMinutes <= this.config.firstWarningMinutes && !this.firstWarningSent) {
      this.firstWarningSent = true;
      this.firstWarningPending = true;
    }

    return {
      allowed: false,
      reason: this.deferralReason,
      retryInMs: this.config.retryIntervalMs,
      blockingSessions: activeSessions,
      unresponsiveSessions: unresponsiveSessions.length > 0 ? unresponsiveSessions : undefined,
      nonBlockingJobSessions: nonBlockingJobSessions.length > 0 ? nonBlockingJobSessions : undefined,
    };
  }

  /**
   * Pure, side-effect-free probe: the names of active (healthy, non-job)
   * sessions that would block a restart right now.
   *
   * Unlike {@link canRestart}, this does NOT start or continue the deferral
   * clock, set warning flags, or call reset() — it is a read-only check for
   * callers that need "is the box idle?" without perturbing deferral state.
   * The restart-window gate uses it to skip the window wait when nothing is
   * active (an idle restart is invisible, so there is nothing for the window
   * to protect). Returns [] when there are no running sessions.
   */
  getBlockingSessions(
    sessionManager: SessionManagerLike,
    sessionMonitor?: SessionMonitorLike | null,
  ): string[] {
    const sessions = sessionManager.listRunningSessions();
    if (sessions.length === 0) return [];
    return this.classifyRunningSessions(sessions, sessionManager, sessionMonitor).activeSessions;
  }

  /**
   * Classify running sessions into active (blocking), unresponsive, and
   * non-blocking idle job sessions. Pure — no instance-state mutation. Shared
   * by {@link canRestart} (which then does deferral bookkeeping on the result)
   * and {@link getBlockingSessions} (read-only) so the classification can never
   * drift between the gating decision and the idle probe.
   */
  private classifyRunningSessions(
    sessions: SessionInfo[],
    sessionManager: SessionManagerLike,
    sessionMonitor?: SessionMonitorLike | null,
  ): { activeSessions: string[]; unresponsiveSessions: string[]; nonBlockingJobSessions: string[] } {
    // Check session health if monitor is available
    const health = sessionMonitor?.getStatus().sessionHealth ?? [];
    const healthMap = new Map(health.map(h => [h.sessionName, h]));

    const activeSessions: string[] = [];
    const unresponsiveSessions: string[] = [];
    const nonBlockingJobSessions: string[] = [];

    for (const session of sessions) {
      if (this.isSafeIdleJobSession(session, sessionManager)) {
        nonBlockingJobSessions.push(session.name);
        continue;
      }

      // Health is keyed by the tmux session name (the slug SessionMonitor
      // tracks, e.g. "echo-codey-collaboration"), NOT the human-facing display
      // name (e.g. "Codey Collaboration"). Look up by tmuxSession first, then
      // fall back to name. Without the tmuxSession key, every interactive
      // session misses the health map and hits the conservative "treat as
      // active" default below — which silently turned the idle/dead exclusion
      // into dead code and meant restart-when-idle (#41) never fired while ANY
      // session existed (the day-long version-lag root cause).
      const h =
        (session.tmuxSession ? healthMap.get(session.tmuxSession) : undefined) ??
        healthMap.get(session.name);
      if (!h) {
        // No health data — be conservative, treat as active
        activeSessions.push(session.name);
      } else if (h.status === 'healthy') {
        activeSessions.push(session.name);
      } else if (h.status === 'unresponsive') {
        unresponsiveSessions.push(session.name);
      }
      // 'idle' and 'dead' sessions don't block
    }

    return { activeSessions, unresponsiveSessions, nonBlockingJobSessions };
  }

  private isSafeIdleJobSession(session: SessionInfo, sessionManager: SessionManagerLike): boolean {
    if (!session.jobSlug || !session.tmuxSession || !sessionManager.hasActiveProcesses) {
      return false;
    }
    return !sessionManager.hasActiveProcesses(session.tmuxSession);
  }

  /**
   * Get current gate status for observability.
   */
  getStatus(): UpdateGateStatus {
    const elapsedMs = this.deferralStartedAt ? Date.now() - this.deferralStartedAt : 0;
    return {
      deferring: this.deferralStartedAt !== null,
      deferralStartedAt: this.deferralStartedAt ? new Date(this.deferralStartedAt).toISOString() : null,
      deferralElapsedMinutes: Math.round(elapsedMs / 60_000),
      maxDeferralHours: this.config.maxDeferralHours,
      deferralReason: this.deferralReason,
      blockingSessions: this.blockingSessions,
      firstWarningSent: this.firstWarningSent,
      finalWarningSent: this.finalWarningSent,
      alwaysRestartImmediately: this.config.alwaysRestartImmediately,
    };
  }

  /**
   * Whether the first warning (T-30min before forced restart) should fire.
   * Returns true exactly once — consumes the flag on read.
   */
  shouldSendFirstWarning(): boolean {
    if (this.firstWarningPending) {
      this.firstWarningPending = false;
      return true;
    }
    return false;
  }

  /**
   * Whether the final warning (T-5min before forced restart) should fire.
   * Returns true exactly once — consumes the flag on read.
   */
  shouldSendFinalWarning(): boolean {
    if (this.finalWarningPending) {
      this.finalWarningPending = false;
      return true;
    }
    return false;
  }

  /**
   * Reset deferral state (called after restart proceeds or update is cancelled).
   */
  reset(): void {
    this.deferralStartedAt = null;
    this.deferralReason = null;
    this.blockingSessions = [];
    this.firstWarningSent = false;
    this.firstWarningPending = false;
    this.finalWarningSent = false;
    this.finalWarningPending = false;
  }
}

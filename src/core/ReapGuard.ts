/**
 * ReapGuard — the shared, stateless "is it safe to reap this session?" guard.
 *
 * Spec: docs/specs/unified-session-lifecycle-robustness.md §P2.
 *
 * Extracted from `SessionReaper.evaluate()` so that EVERY autonomous killer —
 * not just the careful new reaper — consults the same positive-evidence KEEP
 * checks before a session is ended. The single ReapAuthority
 * (`SessionManager.terminateSession`) calls this guard; a non-null result means
 * the session must be KEPT and the terminate is a no-op.
 *
 * Scope is the STATELESS guards only (deps-driven, no per-tick observation
 * state): protected, spawn-grace, recovery-in-flight, pending-injection,
 * relay-lease, recent-user-message, open-commitment, active-subagent,
 * structural-long-work, active-process, main-process-uninspectable/active.
 *
 * The STATEFUL checks — transcript-growth (compares against the previous tick)
 * and positive-idle proof (needs a captured pane frame) — stay inside
 * `SessionReaper.evaluate()`, which calls this guard FIRST (preserving the exact
 * keptBy ordering) and then layers its own per-instance checks.
 *
 * Ordering is identical to the original `evaluate()` so a refactor preserves
 * every `keptBy` reason for the same input (asserted by the reaper's tests).
 */

import type { Session } from './types.js';

export type ReapConfidence = 'high' | 'low';

/** A KEEP verdict: the reason a session must not be reaped, + a confidence. */
export interface ReapKeepReason {
  reason: string;
  confidence: ReapConfidence;
}

/**
 * Signal sources for the stateless guards. A subset of `SessionReaperDeps` so a
 * single set of closures (built once in server.ts) can back both the reaper and
 * the authority. Every "cannot inspect" path resolves to KEEP, never to reap.
 */
export interface ReapGuardDeps {
  protectedSessions: () => string[];
  isRecoveryActive: (session: Session) => boolean;
  hasPendingInjection: (tmuxSession: string) => boolean;
  isRelayLeaseActive: (sessionId: string) => boolean;
  topicBinding: (tmuxSession: string) => number | null;
  recentUserMessage: (topicId: number, withinMs: number) => boolean;
  activeCommitmentForTopic: (topicId: number) => boolean;
  activeSubagentCount: (claudeSessionId: string | undefined) => number;
  buildOrAutonomousActive: (topicId: number | null) => boolean;
  hasActiveProcesses: (tmuxSession: string) => boolean;
  /** Optional main-process CPU/IO liveness. `undefined` ⇒ cannot inspect ⇒ KEEP. */
  mainProcessActive?: (tmuxSession: string) => boolean | undefined;
  now?: () => number;
}

export interface ReapGuardOptions {
  /** Minimum session age before reap-eligibility (spawn grace). 0 disables. */
  minAgeMs: number;
  /** Window for "recent user message" on a bound topic. */
  recentUserWindowMs: number;
  /** Whether an open commitment on the bound topic blocks reaping. */
  protectOpenCommitments: boolean;
  /**
   * Staleness horizon for the open-commitment veto. An open commitment protects a
   * session ONLY while there has been a user message within this window; past it
   * the commitment is treated as abandoned and no longer blocks reaping. A
   * commitment left open for days on a session the user hasn't touched is itself
   * stale — without this bound it pins the dead session forever (the dominant
   * keep-reason behind un-reaped idle sessions). Set to `Infinity` to restore the
   * always-protect behavior. Must be ≥ `recentUserWindowMs`.
   */
  staleCommitmentWindowMs: number;
}

export const DEFAULT_REAP_GUARD_OPTIONS: ReapGuardOptions = {
  minAgeMs: 30 * 60_000,
  recentUserWindowMs: 30 * 60_000,
  protectOpenCommitments: true,
  staleCommitmentWindowMs: 8 * 60 * 60_000, // 8h — "silent 8h ⇒ stale" (operator: restarts are cheap, prefer free resources)
};

export class ReapGuard {
  private readonly deps: ReapGuardDeps;
  private readonly opts: ReapGuardOptions;
  private readonly now: () => number;

  constructor(deps: ReapGuardDeps, opts?: Partial<ReapGuardOptions>) {
    this.deps = deps;
    this.opts = { ...DEFAULT_REAP_GUARD_OPTIONS, ...(opts ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Returns the reason this session must be KEPT (not reaped), or `null` if all
   * stateless guards clear. Cheap-first ordering: in-memory checks before any
   * subprocess fork (process tree / main-process probe) so a guarded session is
   * rejected without paying for a capture.
   *
   * Never throws — a thrown signal source is caught and resolved to KEEP
   * ('guard-error'), because we can never reason about a session we cannot
   * inspect, and the safe answer is always "keep".
   */
  blockedReason(session: Session): ReapKeepReason | null {
    try {
      return this.evaluate(session);
    } catch {
      return { reason: 'guard-error', confidence: 'low' };
    }
  }

  private evaluate(session: Session): ReapKeepReason | null {
    const keep = (reason: string, confidence: ReapConfidence = 'high'): ReapKeepReason => ({
      reason,
      confidence,
    });

    // ── Cheap, in-memory guards first (no subprocess fork) ──
    // A. Protected set.
    if (this.deps.protectedSessions().includes(session.tmuxSession)) return keep('protected');
    // M. Spawn grace — a freshly-spawned session that hasn't had time to produce
    //    output yet must not be reaped. Skipped when minAgeMs is 0.
    if (this.opts.minAgeMs > 0 && session.startedAt) {
      const ageMs = this.now() - Date.parse(session.startedAt);
      if (!(ageMs >= this.opts.minAgeMs)) return keep('spawn-grace');
    }
    // G. Recovery in flight — a kill-to-respawn is mid-flight; never race it.
    if (this.deps.isRecoveryActive(session)) return keep('recovery-in-flight');
    // H. Pending injection (a message is waiting to be delivered to the session).
    if (this.deps.hasPendingInjection(session.tmuxSession)) return keep('pending-injection');
    // Relay lease (an agent-to-agent relay holds this session).
    if (this.deps.isRelayLeaseActive(session.id)) return keep('relay-lease');

    const topicId = this.deps.topicBinding(session.tmuxSession);
    // I. Recent user interaction on the bound topic.
    if (topicId != null && this.deps.recentUserMessage(topicId, this.opts.recentUserWindowMs)) {
      return keep('recent-user-message');
    }
    // J. Open commitment on the bound topic — but only while still recently active.
    //    Guard I above already kept on a message within `recentUserWindowMs`; this
    //    widens the commitment veto to the longer `staleCommitmentWindowMs` horizon.
    //    Past that horizon (no user message — Justin's "no message today" rule) the
    //    commitment is abandoned and must NOT pin the dead session, so we fall
    //    through to the activeness guards below. (2026-06-06 grounding: open-commitment
    //    was the dominant keep-reason — 19/26 sessions, many 26h-idle — that blocked
    //    all idle-session reaping.)
    if (this.opts.protectOpenCommitments && topicId != null && this.deps.activeCommitmentForTopic(topicId)) {
      if (this.deps.recentUserMessage(topicId, this.opts.staleCommitmentWindowMs)) {
        return keep('open-commitment');
      }
      // else: stale commitment — do not veto; continue to activeness guards.
    }
    // K. Active subagent spawned by this session.
    if (this.deps.activeSubagentCount(session.claudeSessionId) > 0) return keep('active-subagent');
    // L. Structural long-work (build / autonomous) on the topic/project.
    if (this.deps.buildOrAutonomousActive(topicId)) return keep('structural-long-work');

    // ── Activeness (positive-evidence) — may fork a subprocess ──
    // C. Process tree: any non-baseline child ⇒ working.
    if (this.deps.hasActiveProcesses(session.tmuxSession)) return keep('active-process');
    // C(main). Main-process CPU/IO delta. undefined ⇒ cannot inspect ⇒ KEEP (low).
    if (this.deps.mainProcessActive) {
      const mp = this.deps.mainProcessActive(session.tmuxSession);
      if (mp === undefined) return keep('process-uninspectable', 'low');
      if (mp === true) return keep('main-process-active');
    }

    // All stateless guards clear. (The reaper layers transcript-growth +
    // positive-idle after this; other killers proceed to terminate.)
    return null;
  }
}

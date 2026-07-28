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
import type { WorkEvidenceName } from './WorkEvidence.js';

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
   * `bypassedReasons` (post-transfer closeout correctness, Part E): an optional
   * set of keep-reasons to TREAT AS BYPASSED. When the cascade would return a
   * reason that is in this set, it is SKIPPED — evaluation continues to the
   * lower-priority guards — so the returned reason is the first keep-reason that
   * is NOT bypassed, or `null` if every remaining guard clears. This is what lets
   * a narrow bypass flag (e.g. `bypassRecentUserMessageForConfirmedMove`) lift
   * EXACTLY ONE reason while every OTHER KEEP-guard is still re-checked — the
   * contract the spec promises. An empty/absent set is byte-identical to the
   * legacy single-eval behavior, and the priority order of the non-bypassed
   * reasons is preserved exactly. `protected` is #1 and must never be supplied as
   * bypassable — the cascade still evaluates it first, so it always wins.
   *
   * Never throws — a thrown signal source is caught and resolved to KEEP
   * ('guard-error'), because we can never reason about a session we cannot
   * inspect, and the safe answer is always "keep".
   */
  blockedReason(session: Session, bypassedReasons?: ReadonlySet<string> | readonly string[]): ReapKeepReason | null {
    try {
      let bypassed: ReadonlySet<string> | undefined;
      if (bypassedReasons instanceof Set) {
        bypassed = bypassedReasons.size > 0 ? bypassedReasons : undefined;
      } else if (Array.isArray(bypassedReasons) && bypassedReasons.length > 0) {
        bypassed = new Set(bypassedReasons);
      }
      return this.evaluate(session, bypassed);
    } catch {
      return { reason: 'guard-error', confidence: 'low' };
    }
  }

  private evaluate(session: Session, bypassed?: ReadonlySet<string>): ReapKeepReason | null {
    // `keep(reason)` returns the KEEP verdict UNLESS `reason` is in the bypassed
    // set — in which case it returns `null`, signalling the caller to SKIP this
    // guard and continue down the cascade to the lower-priority guards. This is
    // the mechanism that makes a narrow bypass re-check every OTHER guard
    // (Part E): a bypassed reason no longer short-circuits the cascade.
    const keep = (reason: string, confidence: ReapConfidence = 'high'): ReapKeepReason | null =>
      bypassed?.has(reason) ? null : { reason, confidence };

    // ── Cheap, in-memory guards first (no subprocess fork) ──
    // A. Protected set. (#1 — never bypassable; `bypassed` is built by the
    //    authority from narrow flags that never include 'protected'.)
    if (this.deps.protectedSessions().includes(session.tmuxSession)) {
      const k = keep('protected');
      if (k) return k;
    }
    // M. Spawn grace — a freshly-spawned session that hasn't had time to produce
    //    output yet must not be reaped. Skipped when minAgeMs is 0.
    if (this.opts.minAgeMs > 0 && session.startedAt) {
      const ageMs = this.now() - Date.parse(session.startedAt);
      if (!(ageMs >= this.opts.minAgeMs)) {
        const k = keep('spawn-grace');
        if (k) return k;
      }
    }
    // G. Recovery in flight — a kill-to-respawn is mid-flight; never race it.
    if (this.deps.isRecoveryActive(session)) {
      const k = keep('recovery-in-flight');
      if (k) return k;
    }
    // H. Pending injection (a message is waiting to be delivered to the session).
    if (this.deps.hasPendingInjection(session.tmuxSession)) {
      const k = keep('pending-injection');
      if (k) return k;
    }
    // Relay lease (an agent-to-agent relay holds this session).
    if (this.deps.isRelayLeaseActive(session.id)) {
      const k = keep('relay-lease');
      if (k) return k;
    }

    const topicId = this.deps.topicBinding(session.tmuxSession);
    // I. Recent user interaction on the bound topic.
    if (topicId != null && this.deps.recentUserMessage(topicId, this.opts.recentUserWindowMs)) {
      const k = keep('recent-user-message');
      if (k) return k;
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
        const k = keep('open-commitment');
        if (k) return k;
      }
      // else: stale commitment — do not veto; continue to activeness guards.
    }
    // K. Active subagent spawned by this session.
    if (this.deps.activeSubagentCount(session.claudeSessionId) > 0) {
      const k = keep('active-subagent');
      if (k) return k;
    }
    // L. Structural long-work (build / autonomous) on the topic/project.
    if (this.deps.buildOrAutonomousActive(topicId)) {
      const k = keep('structural-long-work');
      if (k) return k;
    }

    // ── Activeness (positive-evidence) — may fork a subprocess ──
    // C. Process tree: any non-baseline child ⇒ working.
    if (this.deps.hasActiveProcesses(session.tmuxSession)) {
      const k = keep('active-process');
      if (k) return k;
    }
    // C(main). Main-process CPU/IO delta. undefined ⇒ cannot inspect ⇒ KEEP (low).
    if (this.deps.mainProcessActive) {
      const mp = this.deps.mainProcessActive(session.tmuxSession);
      if (mp === undefined) {
        const k = keep('process-uninspectable', 'low');
        if (k) return k;
      } else if (mp === true) {
        const k = keep('main-process-active');
        if (k) return k;
      }
    }

    // All stateless guards clear. (The reaper layers transcript-growth +
    // positive-idle after this; other killers proceed to terminate.)
    return null;
  }

  /**
   * Observe-only work-evidence collection (reap-notify spec R2.1) — the
   * CHOKEPOINT FALLBACK when the killer supplied no evidence of its own.
   *
   * Documented expected-empty for guard-cleared kills: an autonomous kill
   * reaches the chokepoint's body only when these same closures returned
   * nothing (or a named bypass fired), so a re-run here usually proves
   * nothing — real evidence comes from the killer at its decision point.
   *
   * Differences from `blockedReason` (deliberate, per spec):
   *  - Collects ALL work-POSITIVE signals, not first-hit; protected /
   *    spawn-grace / recovery-in-flight are not work evidence and are skipped.
   *  - A closure that throws contributes NOTHING (no keep-true fail-safe:
   *    "cannot inspect ⇒ keep" is correct for blocking a kill, wrong for
   *    asserting work happened).
   *  - With `skipForkChecks` (pressure tier critical), the fork-based
   *    closures (process tree, main-process probe) are not run and the
   *    `unverified-under-pressure` marker is stamped instead — a record
   *    that verification was skipped, never resume-eligible.
   */
  workEvidence(session: Session, opts?: { skipForkChecks?: boolean }): WorkEvidenceName[] {
    const out: WorkEvidenceName[] = [];
    const probe = (fn: () => boolean, name: WorkEvidenceName): void => {
      try {
        if (fn()) out.push(name);
      } catch {
        // @silent-fallback-ok — closure error ⇒ no evidence from this closure
        // (never keep-true here); the evidence snapshot must never throw into
        // a killer's decision path (reap-notify R2.1).
      }
    };

    probe(() => this.deps.hasPendingInjection(session.tmuxSession), 'pending-injection');
    probe(() => this.deps.isRelayLeaseActive(session.id), 'relay-lease');

    let topicId: number | null = null;
    try {
      topicId = this.deps.topicBinding(session.tmuxSession);
    } catch {
      // @silent-fallback-ok — unresolvable binding ⇒ the topic-scoped probes
      // are skipped; the session-scoped probes still run (same never-throw
      // contract as `probe` above).
      topicId = null;
    }
    if (topicId != null) {
      const boundTopicId = topicId;
      probe(
        () => this.deps.recentUserMessage(boundTopicId, this.opts.recentUserWindowMs),
        'recent-user-message',
      );
      // Open commitment — gated by the SAME staleness horizon evaluate()'s KEEP
      // check uses (guard J above). A commitment counts as in-flight-work evidence
      // ONLY while the topic has had a user message within staleCommitmentWindowMs;
      // past that, evaluate() treats the commitment as abandoned and lets the
      // session die — so workEvidence() must NOT re-assert it as work. Without this
      // gate the two methods disagree on the same commitment: an idle session is
      // killed (evaluate: stale ⇒ reap) then immediately revived (workEvidence:
      // open-commitment ⇒ resume-eligible), forever. They MUST agree on what an
      // open commitment means. (2026-06-13: 13 idle sessions across 6 topics were
      // age-killed + revived in a loop, every one tagged solely [open-commitment]
      // on a commitment the KEEP-guard had already judged stale.)
      probe(
        () =>
          this.opts.protectOpenCommitments &&
          this.deps.activeCommitmentForTopic(boundTopicId) &&
          this.deps.recentUserMessage(boundTopicId, this.opts.staleCommitmentWindowMs),
        'open-commitment',
      );
    }
    probe(() => this.deps.activeSubagentCount(session.claudeSessionId) > 0, 'active-subagent');
    probe(() => this.deps.buildOrAutonomousActive(topicId), 'structural-long-work');

    if (opts?.skipForkChecks) {
      out.push('unverified-under-pressure');
      return out;
    }
    probe(() => this.deps.hasActiveProcesses(session.tmuxSession), 'active-process');
    if (this.deps.mainProcessActive) {
      probe(() => this.deps.mainProcessActive!(session.tmuxSession) === true, 'main-process-active');
    }
    return out;
  }
}

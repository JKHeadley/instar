/**
 * G3 — Lease-gated session spawn (MESH-SELF-HEAL-SPEC §3.3, FD6).
 *
 * The incident: a non-holder machine spawned its OWN session for a topic the
 * holder already owned → two machines served one topic → double-replies. The
 * structural fix is "spawn iff I hold the fenced awake-lease, else forward to
 * the holder." Per the spec's foundation note B, the gate keys on the ONE
 * trustworthy authority — the fenced awake-lease — NOT a placement view (which
 * is not reliably readable from a non-router machine).
 *
 * This module is a PURE decision function (no I/O), mirroring SessionRouter's
 * testable-pure pattern, so both sides of the boundary are unit-testable.
 * The wiring (calling holdsLease(), forwarding via SessionRouter/deliverMessage)
 * lives at the spawn callsites; this only decides spawn-vs-forward.
 *
 * Fail direction: CLOSED (FD6) — under ambiguity (cannot confirm we hold the
 * lease) we do NOT spawn; we forward/defer, and G2's nobody-polling detector is
 * the bounded backstop that guarantees someone ends up serving. A wrongful spawn
 * is the duplicate the spec exists to prevent; a wrongful forward is recovered.
 *
 * Single-machine + flag-off MUST be byte-for-byte the legacy behavior (always
 * spawn locally) — the gate is additive, dark by default.
 */

export interface LeaseGatedSpawnInputs {
  /**
   * Whether THIS machine currently holds the fenced awake-lease.
   * Sourced from MultiMachineCoordinator.holdsLease(), which DEFAULTS TO true on
   * a single-machine agent (no leaseCoordinator) — so single-machine naturally
   * resolves to 'spawn'.
   */
  holdsLease: boolean;
  /** The ownershipCheckedSpawn flag (multiMachine.sessionPool.ownershipCheckedSpawn.enabled). */
  flagEnabled: boolean;
  /** Dry-run: log the intended decision but still spawn locally (observe-only soak). */
  dryRun: boolean;
  /**
   * True when this agent is NOT running multi-machine (no peers / no lease
   * coordinator). A single-machine agent always spawns locally regardless of
   * the flag — the gate is a no-op there.
   */
  singleMachine: boolean;
  /**
   * Whether the forward path (SessionRouter / deliverMessage to the holder) is
   * actually available. If the gate would forward but no forward seam exists,
   * we must NOT strand the message — we fall back to spawning locally and flag
   * it, because a stranded inbound (nobody serves) is worse than a rare
   * duplicate. G2 is the backstop, but the forward seam is the primary path.
   */
  forwardAvailable: boolean;
}

export type LeaseGatedSpawnAction =
  | 'spawn'                    // spawn locally (we hold the lease, or single-machine, or flag-off)
  | 'forward'                  // do NOT spawn; forward inbound to the holder
  | 'dry-run-would-forward'    // flag enabled + dryRun: would forward, but spawn locally this soak
  | 'spawn-forward-unavailable'; // would forward, but no forward seam — spawn locally + flag (no strand)

export interface LeaseGatedSpawnDecision {
  action: LeaseGatedSpawnAction;
  /** True when a session should actually be spawned locally as a result. */
  spawnLocally: boolean;
  /** Short machine-readable reason for the audit log. */
  reason: string;
}

/**
 * Decide whether to spawn a session locally for an inbound topic message, or
 * forward it to the lease holder. Pure: no I/O, fully unit-testable.
 */
export function decideLeaseGatedSpawn(
  inputs: LeaseGatedSpawnInputs,
): LeaseGatedSpawnDecision {
  const { holdsLease, flagEnabled, dryRun, singleMachine, forwardAvailable } = inputs;

  // Legacy / no-op paths — byte-for-byte the prior behavior (always spawn).
  if (!flagEnabled) {
    return { action: 'spawn', spawnLocally: true, reason: 'flag-off-legacy' };
  }
  if (singleMachine) {
    return { action: 'spawn', spawnLocally: true, reason: 'single-machine-noop' };
  }

  // Multi-machine, flag on: gate on the fenced lease.
  if (holdsLease) {
    return { action: 'spawn', spawnLocally: true, reason: 'holds-lease' };
  }

  // We do NOT hold the lease → we must NOT spawn (fail-CLOSED, FD6). Forward to
  // the holder — UNLESS the forward seam is unavailable (then spawn to avoid a
  // strand, and flag it) or we are in dry-run soak (spawn + log the intent).
  if (dryRun) {
    return {
      action: 'dry-run-would-forward',
      spawnLocally: true,
      reason: 'dry-run-would-forward-not-holder',
    };
  }
  if (!forwardAvailable) {
    return {
      action: 'spawn-forward-unavailable',
      spawnLocally: true,
      reason: 'not-holder-but-no-forward-seam-avoid-strand',
    };
  }
  return { action: 'forward', spawnLocally: false, reason: 'not-holder-forward-to-owner' };
}

/**
 * G3.4 — Single-writer binding lifecycle: clear-on-kill (MESH-SELF-HEAL-SPEC §3.3,
 * FD7). The incident: killing a duplicate session did NOT clear its topic→session
 * binding — only an explicit topic pin stopped the re-spawn, so a dead session's
 * stale binding could silently resurrect work. The invariant is "a binding exists
 * IFF a live session exists for it": the moment a session is killed, its binding
 * must go.
 *
 * Safety note (why clearing on kill never breaks resume): the topic→session
 * binding maps topicId→tmux-session-name; the RESUME UUID lives separately in
 * TopicResumeMap keyed by topicId. Clearing the binding to a dead tmux session
 * does not touch the resume UUID — the next inbound for the topic re-spawns a
 * FRESH session (with --resume) and re-registers a new binding. We are only
 * removing a pointer at a corpse.
 *
 * Pure: no I/O. The wiring (resolving the topic for the killed session, calling
 * unregisterTopic, the audit line) lives at the beforeSessionKill listener.
 *
 * Gating mirrors the spawn gate: dark + dryRun by default ⇒ a strict no-op until
 * the operator opts into the G3 single-writer binding lifecycle.
 */
export interface BindingCleanupOnKillInputs {
  /** The ownershipCheckedSpawn flag (multiMachine.sessionPool.ownershipCheckedSpawn.enabled). */
  flagEnabled: boolean;
  /** Dry-run: record the counterfactual but DO NOT clear the binding (observe-only soak). */
  dryRun: boolean;
  /** True when the killed session has a resolvable topic→session binding to clear. */
  hasBinding: boolean;
  /**
   * True when this kill is immediately followed by a SAME-TOPIC respawn
   * (context-exhaustion / recovery bounce, framework swap). The respawn resolves
   * its target via getSessionForTopic, so clearing the binding first would make
   * that lookup return null and the recovery silently abort. A respawn-kill must
   * NEVER clear the binding (and must not record a would-clear counterfactual,
   * since clearing would be the WRONG action there). Mirrors the resume-UUID-save
   * listener's contextExhaustionKills guard. Defaults false (a terminal kill).
   */
  respawnImminent?: boolean;
}

export type BindingCleanupAction =
  | 'clear'                  // unregister the stale binding now (enforcement firing)
  | 'dry-run-would-clear'    // flag on + dryRun: would clear, but leave it this soak
  | 'skip-no-binding'        // nothing bound to this killed session — nothing to clear
  | 'skip-respawn-kill'      // kill is followed by a same-topic respawn — keep the binding
  | 'skip-legacy';           // flag off → legacy behavior (binding persists, as before)

export interface BindingCleanupDecision {
  action: BindingCleanupAction;
  /** True when the binding should actually be unregistered as a result. */
  clearNow: boolean;
  /** Short machine-readable reason for the audit log. */
  reason: string;
}

/**
 * Decide whether to clear a killed session's topic→session binding. Pure: no I/O,
 * fully unit-testable on both sides of the boundary.
 */
export function decideBindingCleanupOnKill(
  inputs: BindingCleanupOnKillInputs,
): BindingCleanupDecision {
  const { flagEnabled, dryRun, hasBinding, respawnImminent } = inputs;

  // Flag off ⇒ byte-for-byte the legacy behavior (binding persists across kill).
  if (!flagEnabled) {
    return { action: 'skip-legacy', clearNow: false, reason: 'flag-off-legacy' };
  }
  // Nothing bound to this session ⇒ nothing to clear (not a counterfactual either).
  if (!hasBinding) {
    return { action: 'skip-no-binding', clearNow: false, reason: 'no-binding-for-session' };
  }
  // Kill is immediately followed by a same-topic respawn (recovery bounce) ⇒ keep
  // the binding so the respawn's getSessionForTopic lookup still resolves. Takes
  // precedence over dryRun so we never record a would-clear counterfactual that
  // would, if promoted, BREAK recovery. (G3 side-effects second-pass review.)
  if (respawnImminent) {
    return { action: 'skip-respawn-kill', clearNow: false, reason: 'respawn-imminent-keep-binding' };
  }
  // Observe-only soak: record the counterfactual, leave the binding in place.
  if (dryRun) {
    return {
      action: 'dry-run-would-clear',
      clearNow: false,
      reason: 'dry-run-would-clear-stale-binding',
    };
  }
  // Enabled + live: enforce the invariant — clear the stale binding now.
  return { action: 'clear', clearNow: true, reason: 'clear-stale-binding-on-kill' };
}

/**
 * Soak-evidence ledger (operator directive 2026-06-27 — "observe-mode must record
 * EVALUABLE counterfactual evidence, not a throwaway log line; otherwise it's
 * useless and can never justify promotion"). This is the structured metric that
 * lets a later promotion-review say, concretely, "G3 caught N real duplicate-spawn
 * attempts in dryRun over the soak → promote it" (or "never fired → remove it").
 *
 * THE load-bearing counterfactual metric is `wouldHavePreventedDuplicate`: in
 * dry-run, every `dry-run-would-forward` is a duplicate session this gate WOULD
 * have prevented had it been enabled — i.e. a real instance of the incident's harm
 * that the gate would have stopped. A nonzero, growing count over a clean soak is
 * the evidence FOR promotion; a flat zero over a long soak is evidence the gate is
 * a no-op here (consider removal). Either way the loop can close.
 */
export interface LeaseGatedSpawnSoakSummary {
  /** Decisions observed total. */
  decisions: number;
  /** Spawned locally because we hold the lease (the normal, correct path). */
  spawnedAsHolder: number;
  /** Spawned locally as a single-machine / flag-off no-op. */
  spawnedLegacy: number;
  /** Actually forwarded (gate enabled, non-dry-run, not holder) — enforcement firing. */
  forwarded: number;
  /**
   * THE counterfactual: in dry-run, a non-holder spawn the gate WOULD have
   * forwarded — i.e. a duplicate session it would have prevented if enabled.
   */
  wouldHavePreventedDuplicate: number;
  /** Not holder but no forward seam available → spawned to avoid a strand (a gap to close). */
  spawnedNoForwardSeam: number;
  // ── G3.4 binding-cleanup-on-kill counters (single-writer invariant) ──
  /** Binding-cleanup decisions observed on session-kill. */
  bindingCleanupDecisions: number;
  /** Stale bindings actually cleared on kill (enforcement firing). */
  bindingsCleared: number;
  /**
   * THE binding-cleanup counterfactual: in dry-run, each killed session that
   * still had a binding is a stale binding the gate WOULD have cleared — i.e. a
   * potential silent stale-respawn it would have prevented if enabled.
   */
  wouldHaveClearedStaleBinding: number;
  firstAt: string | null;
  lastAt: string | null;
}

export class LeaseGatedSpawnSoakLedger {
  private s: LeaseGatedSpawnSoakSummary = {
    decisions: 0,
    spawnedAsHolder: 0,
    spawnedLegacy: 0,
    forwarded: 0,
    wouldHavePreventedDuplicate: 0,
    spawnedNoForwardSeam: 0,
    bindingCleanupDecisions: 0,
    bindingsCleared: 0,
    wouldHaveClearedStaleBinding: 0,
    firstAt: null,
    lastAt: null,
  };

  /** Record one decision. `nowIso` is injected (callers pass a real timestamp). */
  record(decision: LeaseGatedSpawnDecision, nowIso: string): void {
    this.s.decisions += 1;
    if (this.s.firstAt === null) this.s.firstAt = nowIso;
    this.s.lastAt = nowIso;
    switch (decision.action) {
      case 'spawn':
        if (decision.reason === 'holds-lease') this.s.spawnedAsHolder += 1;
        else this.s.spawnedLegacy += 1; // flag-off-legacy | single-machine-noop
        break;
      case 'forward':
        this.s.forwarded += 1;
        break;
      case 'dry-run-would-forward':
        this.s.wouldHavePreventedDuplicate += 1;
        break;
      case 'spawn-forward-unavailable':
        this.s.spawnedNoForwardSeam += 1;
        break;
    }
  }

  /**
   * Record one binding-cleanup-on-kill decision (G3.4). `nowIso` is injected.
   * Only decisions that touch a real binding (clear / would-clear) advance the
   * counters; skip-legacy / skip-no-binding are non-events for the soak metric.
   */
  recordBindingCleanup(decision: BindingCleanupDecision, nowIso: string): void {
    switch (decision.action) {
      case 'clear':
        this.s.bindingCleanupDecisions += 1;
        this.s.bindingsCleared += 1;
        break;
      case 'dry-run-would-clear':
        this.s.bindingCleanupDecisions += 1;
        this.s.wouldHaveClearedStaleBinding += 1;
        break;
      // skip-legacy / skip-no-binding: nothing to count (no binding was at risk).
      default:
        return;
    }
    if (this.s.firstAt === null) this.s.firstAt = nowIso;
    this.s.lastAt = nowIso;
  }

  summary(): LeaseGatedSpawnSoakSummary {
    return { ...this.s };
  }

  /**
   * A promotion recommendation derived from the soak evidence — the thing that
   * was NEVER produced before (operator: "you've never once recommended promoting
   * a dark feature"). Deterministic, evidence-based, advisory.
   */
  promotionSignal(minDuplicatesToPromote = 1): {
    recommendation: 'promote' | 'keep-soaking' | 'consider-removal' | 'enforcing';
    why: string;
  } {
    const s: LeaseGatedSpawnSoakSummary = this.s;
    if (s.forwarded > 0 || s.bindingsCleared > 0) {
      const parts: string[] = [];
      if (s.forwarded > 0) parts.push(`forwarded ${s.forwarded} inbound(s) to the holder`);
      if (s.bindingsCleared > 0) parts.push(`cleared ${s.bindingsCleared} stale binding(s) on kill`);
      return { recommendation: 'enforcing', why: `gate is live and has ${parts.join(' and ')}` };
    }
    const counterfactual = s.wouldHavePreventedDuplicate + s.wouldHaveClearedStaleBinding;
    if (counterfactual >= minDuplicatesToPromote) {
      return {
        recommendation: 'promote',
        why: `dry-run would have prevented ${s.wouldHavePreventedDuplicate} duplicate session(s) and cleared ${s.wouldHaveClearedStaleBinding} stale binding(s) — real harm the gate stops; promote to enabled`,
      };
    }
    const observed = s.decisions + s.bindingCleanupDecisions;
    if (observed === 0) {
      return { recommendation: 'keep-soaking', why: 'no decisions observed yet' };
    }
    return {
      recommendation: 'consider-removal',
      why: `${observed} decision(s) observed, 0 counterfactual prevention — the gate has not fired usefully here`,
    };
  }
}

/**
 * The minimal binding-registry surface the kill-time cleanup needs. Mirrors the
 * relevant slice of TelegramAdapter (getTopicForSession / unregisterTopic) so the
 * cleanup wiring is unit-testable against a fake without a real adapter/tmux.
 */
export interface BindingRegistryPort {
  getTopicForSession(sessionName: string): number | null;
  unregisterTopic(topicId: number): void;
}

/**
 * G3.4 wiring helper — resolve the killed session's topic binding, decide whether
 * to clear it (pure fn), record the soak counterfactual, and on a live decision
 * actually unregister the stale binding. Returns the decision for the caller's
 * audit. Kept here (not inlined at the beforeSessionKill listener) so the
 * single-writer-on-kill invariant has a wiring-integrity test target.
 *
 * Order contract: the caller MUST run this AFTER the resume-UUID save (the UUID
 * lives in TopicResumeMap keyed by topicId, so clearing the binding can't lose
 * it — but resolving the topic for the UUID save reads the same binding, so save
 * first, clear second).
 */
export interface BindingCleanupAuditEntry {
  ts: string;
  /** 'binding-cleared' when actually cleared; 'binding-would-clear' in dry-run. */
  event: 'binding-cleared' | 'binding-would-clear';
  topicId: number;
  sessionName: string;
  dryRun: boolean;
  reason: string;
}

export function applyBindingCleanupOnKill(args: {
  registry: BindingRegistryPort;
  sessionName: string;
  flagEnabled: boolean;
  dryRun: boolean;
  ledger: LeaseGatedSpawnSoakLedger;
  nowIso: string;
  log?: (msg: string) => void;
  /** Optional durable audit sink (logs/mesh-selfheal.jsonl) — invoked ONLY on a
   *  real transition (clear / would-clear), never on a skip. Spec §6. */
  audit?: (entry: BindingCleanupAuditEntry) => void;
  /** True when a same-topic respawn follows this kill (recovery bounce) — keep the
   *  binding so recovery's getSessionForTopic lookup resolves. See input docs. */
  respawnImminent?: boolean;
}): BindingCleanupDecision {
  const { registry, sessionName, flagEnabled, dryRun, ledger, nowIso, log, audit, respawnImminent } = args;
  const topicId = registry.getTopicForSession(sessionName);
  const decision = decideBindingCleanupOnKill({
    flagEnabled,
    dryRun,
    hasBinding: topicId !== null,
    respawnImminent,
  });
  ledger.recordBindingCleanup(decision, nowIso);
  if (decision.clearNow && topicId !== null) {
    registry.unregisterTopic(topicId);
    log?.(`[g3-binding-cleanup] cleared stale binding for topic ${topicId} (session "${sessionName}") on kill — binding-IFF-live-session`);
    audit?.({ ts: nowIso, event: 'binding-cleared', topicId, sessionName, dryRun, reason: decision.reason });
  } else if (decision.action === 'dry-run-would-clear' && topicId !== null) {
    log?.(`[g3-binding-cleanup] DRY-RUN would clear stale binding for topic ${topicId} (session "${sessionName}") on kill`);
    audit?.({ ts: nowIso, event: 'binding-would-clear', topicId, sessionName, dryRun, reason: decision.reason });
  }
  return decision;
}

/**
 * Process-wide shared soak ledger — one source of truth for the G3 gate's
 * evaluable evidence. server.ts (the spawn callsites) RECORDS to it; routes.ts
 * (GET /mesh-selfheal/g3) READS it for the operator's promotion-evidence surface.
 * A shared singleton avoids threading the ledger through AgentServer's RouteContext.
 */
export const sharedG3SoakLedger = new LeaseGatedSpawnSoakLedger();

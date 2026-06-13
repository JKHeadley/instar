/**
 * SessionOwnership — per-session ownership state machine for the Multi-Machine
 * Session Pool (spec §L3). Exactly one machine runs a session at any instant;
 * ownership is movable and fenced by a (status, epoch) pair, advanced by a
 * per-session CAS at `ownershipEpoch+1`.
 *
 * This module is PURE LOGIC — the legal transitions, the run-fence (who may run
 * the agent), the output-exclusion contract (who may write to the user channel
 * during a transfer), and the per-session nonce scoping. The durable CAS (the
 * per-session git single-ref fast-forward push of §L−1) and the distributed
 * registry sit on top and call these to validate every ownership change.
 *
 * The handoff is **claim-before-release, gated by the state machine** — NOT
 * release-before-claim. Authoritative sequence for a transfer of session K from
 * source S to target T:
 *   active(owner=S, e) → transferring(from=S, to=T, e+1) → active(owner=T, e+2) → S tears down (local)
 * Because the fence is (status, epoch) — not the physical release — there is no
 * double-run (only one machine ever sees itself active at the top epoch) and no
 * no-owner gap (transferring still names S as the draining owner until T is active).
 */

export type SessionOwnershipStatus = 'placing' | 'active' | 'transferring' | 'released';

export interface SessionOwnershipRecord {
  sessionKey: string;
  ownerMachineId: string;
  ownershipEpoch: number;
  status: SessionOwnershipStatus;
  /** During `transferring`: the target machine the session is moving to. */
  transferTo?: string;
  /** WS1.2: this transferring record was set by the DRAIN flow — the owner's
   *  SessionDrainRunner will land the target's claim itself at drain
   *  completion. Consumers (the WS1.3 reconciler) hold their backstop claim
   *  for the drain grace instead of front-running the live drain. Absent on
   *  reconciler-cooperative transfers (claim promptly) and on records from
   *  pre-WS1.2 peers. */
  drainInFlight?: boolean;
  nonce: string;
  timestamp: number;
  updatedAt: string;
  signature?: string;
}

export type OwnershipAction =
  | { type: 'place'; machineId: string } // router assigns a new session to machineId
  | { type: 'claim'; machineId: string } // target claims → active (new session, or transfer target)
  | { type: 'transfer'; to: string; drain?: boolean } // current owner → transferring(to); drain=true ⇒ WS1.2 drain flow
  | { type: 'release'; machineId: string } // owner ends the session
  /**
   * WS1.3 (MULTI-MACHINE-SEAMLESSNESS-SPEC): claim ownership of a record whose
   * owner is PROVABLY DEAD — the convergence-deadline path for a pin/owner
   * divergence that cannot reconcile cooperatively because the owner machine is
   * gone. The FSM only enforces sequencing + the fenced epoch increment (the
   * stale owner's later CAS attempts fail at the old epoch — clock-proof);
   * DEATH EVIDENCE (offline past the bound, lease lapse, quorum membership) is
   * validated by the caller (OwnershipReconciler) BEFORE issuing the action,
   * never by wall-clock timers alone. A reachable-but-slow owner must get the
   * cooperative transfer path, never a force-claim.
   */
  | { type: 'force-claim'; machineId: string }
  /**
   * WS1.2 (MULTI-MACHINE-SEAMLESSNESS-SPEC): the emergency-stop-during-drain
   * path — the CURRENT owner aborts its own in-flight transfer and returns to
   * `active` at epoch+1, so the topic STAYS on the old machine and nothing is
   * left split. The fenced epoch increment makes the stale target's later
   * claim fail (claim-out-of-sequence on an active record at a newer epoch).
   * Owner-only by construction: only the machine the transferring record
   * names may abort.
   */
  | { type: 'abort-transfer'; machineId: string };

export type OwnershipReason =
  | 'ok'
  | 'already-placed'
  | 'claim-out-of-sequence'
  | 'claim-wrong-machine'
  | 'transfer-not-active'
  | 'release-not-owner'
  | 'release-requires-active'
  | 'force-claim-self'
  | 'abort-not-transferring'
  | 'abort-not-owner'
  | 'no-record';

/**
 * Pure transition. Given the CURRENT record (or null for a never-seen session)
 * and an action, returns the next record (the CAS candidate, at epoch+1) or a
 * typed rejection. Epoch arithmetic + legal sequencing are enforced here; the
 * CAS layer then attempts to land `next` via a fast-forward push.
 */
export function applyOwnershipAction(
  current: SessionOwnershipRecord | null,
  action: OwnershipAction,
  ctx: { sessionKey: string; nonce: string; now: number; epochFloor?: number },
): { ok: true; next: SessionOwnershipRecord } | { ok: false; reason: OwnershipReason } {
  const base = {
    sessionKey: ctx.sessionKey,
    nonce: ctx.nonce,
    timestamp: ctx.now,
    updatedAt: new Date(ctx.now).toISOString(),
  };
  // Epoch floor (live-matrix finding #7, 2026-06-06): the registry is
  // in-memory, so a restart resets epochs to 0 for quiet sessions — and the
  // coherence journal's (topic, epoch) op-key then DEDUPES the re-placed
  // session's placement entries as replays, leaving the durable evidence
  // pointing at the WRONG machine. The caller may supply a floor (the newest
  // journaled epoch for this session) so post-restart epochs stay monotonic.
  const epoch = Math.max(current?.ownershipEpoch ?? 0, ctx.epochFloor ?? 0);

  switch (action.type) {
    case 'place': {
      // Only for a never-seen or released session — never steal a live one.
      if (current && current.status !== 'released') return { ok: false, reason: 'already-placed' };
      return { ok: true, next: { ...base, ownerMachineId: action.machineId, ownershipEpoch: epoch + 1, status: 'placing' } };
    }
    case 'claim': {
      if (!current) return { ok: false, reason: 'no-record' };
      if (current.status === 'placing') {
        // New-session claim: only the placed-owner may claim.
        if (current.ownerMachineId !== action.machineId) return { ok: false, reason: 'claim-wrong-machine' };
        return { ok: true, next: { ...base, ownerMachineId: action.machineId, ownershipEpoch: epoch + 1, status: 'active' } };
      }
      if (current.status === 'transferring') {
        // Transfer claim: only the named transfer target may claim.
        if (current.transferTo !== action.machineId) return { ok: false, reason: 'claim-wrong-machine' };
        return { ok: true, next: { ...base, ownerMachineId: action.machineId, ownershipEpoch: epoch + 1, status: 'active' } };
      }
      // active/released → a claim is out of sequence (e.g. T claims before transferring).
      return { ok: false, reason: 'claim-out-of-sequence' };
    }
    case 'transfer': {
      if (!current || current.status !== 'active') return { ok: false, reason: 'transfer-not-active' };
      return {
        ok: true,
        next: {
          ...base, ownerMachineId: current.ownerMachineId, ownershipEpoch: epoch + 1, status: 'transferring', transferTo: action.to,
          ...(action.drain ? { drainInFlight: true } : {}),
        },
      };
    }
    case 'force-claim': {
      // WS1.3 dead-owner takeover. Legal on a live record (active/transferring/
      // placing) precisely because the cooperative paths are closed when the
      // owner is gone — and on a released/missing record the normal place→claim
      // path applies instead (use that, not force). Claiming what you already
      // own is a no-op worth rejecting loudly (it would burn an epoch for
      // nothing and masks a reconciler bug).
      if (!current) return { ok: false, reason: 'no-record' };
      if (current.ownerMachineId === action.machineId && current.status === 'active') {
        return { ok: false, reason: 'force-claim-self' };
      }
      return { ok: true, next: { ...base, ownerMachineId: action.machineId, ownershipEpoch: epoch + 1, status: 'active' } };
    }
    case 'abort-transfer': {
      // WS1.2 emergency-stop-during-drain: only the DRAINING OWNER of a
      // `transferring` record may abort, returning itself to `active` at
      // epoch+1 (the fence that invalidates the stale target's claim).
      if (!current || current.status !== 'transferring') return { ok: false, reason: 'abort-not-transferring' };
      if (current.ownerMachineId !== action.machineId) return { ok: false, reason: 'abort-not-owner' };
      return {
        ok: true,
        next: { ...base, ownerMachineId: action.machineId, ownershipEpoch: epoch + 1, status: 'active' },
      };
    }
    case 'release': {
      if (!current) return { ok: false, reason: 'no-record' };
      // Release is the LAST step of the lifecycle — only an ACTIVE owner may release.
      // Releasing while `transferring` is forbidden: it would advance the record to
      // `released` before the target T claims, and T's subsequent claim is then
      // rejected (claim-out-of-sequence on a released record), orphaning the session.
      // The §L3 handoff order is active(S)→transferring→active(T)→S-release, so S never
      // releases the registry record during transfer (after T claims, the record is
      // owned by T; S's teardown is local). (Fixes the 2026-05-29 pre-merge review crit.)
      if (current.status !== 'active') return { ok: false, reason: 'release-requires-active' };
      if (current.ownerMachineId !== action.machineId) return { ok: false, reason: 'release-not-owner' };
      return { ok: true, next: { ...base, ownerMachineId: current.ownerMachineId, ownershipEpoch: epoch + 1, status: 'released' } };
    }
    default:
      return { ok: false, reason: 'no-record' };
  }
}

/**
 * Run-fence (spec §L3): a worker may RUN the agent for a session ONLY while it
 * observes itself as the `active` owner at the current epoch. During
 * `transferring` NO machine runs new turns (the draining owner finishes via the
 * output-exclusion contract; the target is not yet active).
 */
export function mayRun(record: SessionOwnershipRecord | null, machineId: string, effectiveEpoch: number): boolean {
  if (!record) return false;
  return record.status === 'active' && record.ownerMachineId === machineId && record.ownershipEpoch === effectiveEpoch;
}

export interface EmitDecision {
  /** May this machine write to the user channel at all right now? */
  mayEmit: boolean;
  /** If mayEmit, may it emit NEW output (vs only drain an in-flight reply)? */
  newOutputAllowed: boolean;
}

/**
 * Output-exclusion contract (spec §L3) — distinct from the run-fence. During a
 * transfer the draining source and the freshly-active target overlap in time, so
 * channel emission is gated separately so the user never sees interleaved/double
 * output:
 *  - The draining source (record `transferring`, from === machine) MAY emit the
 *    TAIL of an in-flight reply within [transferringStartedAt, +cutoffMs], but no
 *    NEW output, and nothing past the cutoff.
 *  - The target (record `active`, owner === machine, after its CAS) emits only
 *    once the cutoff has elapsed since `transferringStartedAt` (so the two
 *    windows are disjoint by construction).
 *  - The steady-state active owner (no transfer in flight) emits freely.
 */
export function mayEmit(
  record: SessionOwnershipRecord | null,
  machineId: string,
  opts: { now: number; transferringStartedAt?: number; cutoffMs?: number },
): EmitDecision {
  if (!record) return { mayEmit: false, newOutputAllowed: false };
  const cutoff = opts.cutoffMs ?? 1000;
  if (record.status === 'active' && record.ownerMachineId === machineId) {
    // If this active owner just won a transfer, hold until the source's drain
    // window has closed (disjoint windows). transferringStartedAt is the router-
    // stamped time the `transferring` state began.
    if (opts.transferringStartedAt != null && opts.now < opts.transferringStartedAt + cutoff) {
      return { mayEmit: false, newOutputAllowed: false };
    }
    return { mayEmit: true, newOutputAllowed: true };
  }
  if (record.status === 'transferring' && record.ownerMachineId === machineId) {
    // Draining source: tail-only, until the cutoff.
    const within = opts.transferringStartedAt != null && opts.now < opts.transferringStartedAt + cutoff;
    return { mayEmit: within, newOutputAllowed: false };
  }
  return { mayEmit: false, newOutputAllowed: false };
}

/**
 * Per-session nonce scoping (spec §L3): the replay-guard key is the tuple
 * {sessionKey, sender, ownershipEpoch} — NOT a global nonce space. The same
 * nonce value used in two different sessions does not collide; a replay WITHIN a
 * session's CAS sequence is caught.
 */
export function ownershipNonceKey(sessionKey: string, sender: string, ownershipEpoch: number, nonce: string): string {
  return `${sessionKey} ${sender} ${ownershipEpoch} ${nonce}`;
}

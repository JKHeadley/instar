/**
 * transitions.ts — TS port of the feedback-factory lifecycle state machine.
 *
 * Scar (a) (the evidence gate, processor side) + part of scar (c)/(d). Byte-exact
 * port of `V2_STATES` (:1000), `V2_TRANSITIONS` (:1009), `TRANSITION_GATES`
 * (:1028), `can_transition` (:1045), and `detect_cycling` (:1139) from the
 * reference `the-portal/.claude/scripts/feedback-processor.py`. These are the
 * pure decision functions: which lifecycle transitions are legal, what evidence
 * a terminal transition demands, the chronic circuit-breaker, and whether a
 * cluster is cycling. The DB-coupled drivers (cmd_transition, the version-anchored
 * half of can_transition_to_verified) are later increments — this module is the
 * pure, parity-testable core.
 *
 * The reason strings interpolate Python's `sorted(set)` list-repr; pyListRepr()
 * reproduces it (single-quoted, comma-space, alphabetical) so the parity harness
 * matches BOTH the `allowed` decision and the `reason` text byte-for-byte.
 */

/** Python V2_STATES (:1000) — set membership only; order irrelevant. */
export const V2_STATES: ReadonlySet<string> = new Set([
  'new', 'investigating', 'research_complete', 'fix_applied',
  'dispatched', 'verified_tentative', 'verified', 'closed',
  'chronic', 'chronic_escalated', 'deferred',
  'wontfix', 'duplicate',
  'needs_human_verify', // legacy (accepted for backward compat)
]);

/** Python V2_TRANSITIONS (:1009) — allowed target states per current state. */
export const V2_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  new: new Set(['investigating', 'wontfix', 'duplicate', 'deferred']),
  investigating: new Set(['research_complete', 'wontfix', 'duplicate', 'deferred']),
  research_complete: new Set(['fix_applied', 'investigating']),
  fix_applied: new Set(['dispatched', 'chronic']),
  dispatched: new Set(['verified', 'verified_tentative', 'chronic']),
  verified_tentative: new Set(['verified', 'closed', 'chronic']),
  verified: new Set(['closed', 'chronic']),
  chronic: new Set(['investigating', 'chronic_escalated', 'wontfix']),
  deferred: new Set(['new']),
  chronic_escalated: new Set(),
  closed: new Set(),
  wontfix: new Set(),
  duplicate: new Set(),
  needs_human_verify: new Set(['verified', 'wontfix', 'duplicate']),
};

/** Python TRANSITION_GATES (:1028) — extra hard gates beyond state legality. */
export const TRANSITION_GATES: Readonly<Record<string, { required_context: string; error: string }>> = {
  dispatched: {
    required_context: 'dispatch_id',
    error: 'Cannot transition to dispatched without dispatch_id. Dispatch creation is ATOMIC with dispatch transition.',
  },
};

const EVIDENCE_REQUIRED: ReadonlySet<string> = new Set(['wontfix', 'closed', 'chronic_escalated']);

/** Reproduce Python's `repr(sorted(setOfStrings))` for simple identifier strings. */
function pyListRepr(values: Iterable<string>): string {
  const sorted = [...values].sort();
  return '[' + sorted.map((v) => `'${v}'`).join(', ') + ']';
}

export interface TransitionContext {
  dispatch_id?: string;
  recurrenceCount?: number;
  [k: string]: unknown;
}

/**
 * Port of Python `can_transition` (:1045). Returns `[allowed, reason]`.
 * Pure: no I/O. Mirrors the reference's check order exactly (invalid target →
 * unknown current → illegal transition → evidence gate → hard gate → chronic
 * circuit-breaker), so the first-failing reason matches the reference.
 */
export function canTransition(
  currentStatus: string,
  newStatus: string,
  justification?: string | null,
  context?: TransitionContext | null,
): [boolean, string] {
  const ctx = context ?? {};

  if (!V2_STATES.has(newStatus)) {
    return [false, `Invalid state: ${newStatus}. Valid: ${pyListRepr(V2_STATES)}`];
  }
  if (!(currentStatus in V2_TRANSITIONS)) {
    return [false, `Unknown current state: ${currentStatus}`];
  }
  const allowedTargets = V2_TRANSITIONS[currentStatus];
  if (!allowedTargets.has(newStatus)) {
    // Python: f"... Allowed: {sorted(...) or 'none (terminal)'}" — empty list is falsy.
    const allowedStr = allowedTargets.size > 0 ? pyListRepr(allowedTargets) : 'none (terminal)';
    return [false, `Cannot transition ${currentStatus} -> ${newStatus}. Allowed: ${allowedStr}`];
  }

  if (EVIDENCE_REQUIRED.has(newStatus)) {
    if (!justification || justification.trim().length < 20) {
      return [false, `Transitioning to '${newStatus}' requires justification (min 20 chars)`];
    }
  }

  if (newStatus in TRANSITION_GATES) {
    const gate = TRANSITION_GATES[newStatus];
    const requiredKey = gate.required_context;
    if (requiredKey && !ctx[requiredKey]) {
      return [false, gate.error];
    }
  }

  if (newStatus === 'chronic') {
    const recurrence = (ctx.recurrenceCount as number) ?? 0;
    if (recurrence >= 3) {
      return [false, `chronicCount (${recurrence}) >= 3. Must transition to chronic_escalated instead (circuit breaker).`];
    }
  }

  return [true, 'OK'];
}

/** Port of Python `detect_cycling` (:1139): fix_applied/new/investigating with recurrenceCount ≥ 2. */
export function detectCycling(cluster: { status?: string; recurrenceCount?: number }): boolean {
  const status = cluster.status;
  return (
    (status === 'fix_applied' || status === 'new' || status === 'investigating') &&
    (cluster.recurrenceCount ?? 0) >= 2
  );
}

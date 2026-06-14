/**
 * JobLeaseCutoverGate — WS4.3 journal-lease cutover discipline.
 *
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.3, "Cutover discipline".)
 *
 * Job claims upgrade from the legacy best-effort AgentBus broadcast
 * (`JobClaimManager`) to a durable, epoch-fenced lease carried over the
 * replicated journal. The named migration hazard the spec closes is two
 * NON-INTEROPERATING claim mechanisms running at once: one machine leasing
 * via the journal while a peer broadcasts via the bus for the SAME job set.
 * There must never be a window where both are live for a job.
 *
 * This gate is the SINGLE decision point that resolves which path a job uses.
 * It engages the journal-lease path ONLY when invariant-5 flag coherence holds:
 *   1. the dark flag `multiMachine.seamlessness.ws43JournalLease` is on;
 *   2. the pool has at least one peer (single-machine = strict no-op, the
 *      legacy path is byte-for-byte today's behavior);
 *   3. EVERY online peer advertises the `ws43JournalLease` capability in its
 *      `seamlessnessFlags` heartbeat — a peer that does not advertise it (an
 *      older version, or the flag off there) keeps the WHOLE pool on the bus.
 *
 * A peer with NO seamlessnessFlags field is an older version → treated as NOT
 * advertising (the conservative side). Absent = non-participant, per the
 * spec's invariant-5 ("absent = the peer predates this spec = flag-state-off").
 *
 * Pure + deterministic: the gate holds no state and performs no IO, so it is
 * trivially testable and can be re-read live at every spawn boundary (a
 * mid-run flag flip or a peer going dark cuts the pool back to the bus
 * immediately, never stranding a half-migrated job set).
 */

/** A peer's advertised seamlessness capability, read from its heartbeat. */
export interface CutoverPeerAdvert {
  machineId: string;
  /** Whether the peer is currently online. An offline peer is not a participant
   *  in coherence (it cannot lease or broadcast right now) and is excluded. */
  online?: boolean;
  /** The peer's advertised WS4.3 journal-lease capability. ABSENT/false = the
   *  peer does not advertise it (older version or flag off there). */
  ws43JournalLease?: boolean;
}

/** Inputs to the cutover decision, all read LIVE at each evaluation. */
export interface CutoverGateInput {
  /** `multiMachine.seamlessness.ws43JournalLease` resolved live. */
  enabled: boolean;
  /** `multiMachine.seamlessness.ws43JournalLeaseDryRun` resolved live. When
   *  true AND the gate would otherwise select 'journal', the journal claim is
   *  LOGGED as intended but the legacy bus path still runs (the WS-wide dry-run
   *  posture: "log intended refusals/claims"). */
  dryRun: boolean;
  /** Every KNOWN peer (excluding self) with its advertised capability. An empty
   *  list means single-machine (no peers) → strict no-op. */
  peers: ReadonlyArray<CutoverPeerAdvert>;
}

/** Which claim mechanism a job must use this evaluation. */
export type ClaimPath = 'journal' | 'bus';

export interface CutoverDecision {
  /** The claim path the scheduler must use. Exactly one — never both. */
  path: ClaimPath;
  /** When true, the journal claim should be LOGGED as intended but the bus path
   *  actually runs (dry-run). Only ever true alongside `path: 'bus'`. */
  journalDryRun: boolean;
  /** Machine-readable reason, for audit + the status surface. */
  reason:
    | 'flag-off'
    | 'single-machine'
    | 'peers-incoherent'
    | 'dry-run'
    | 'journal-coherent';
  /** Online peers that do NOT advertise the capability (empty ⇒ coherent). The
   *  reason a coherent-pool cutover was withheld, surfaced for the operator. */
  incoherentPeers: string[];
}

/**
 * Resolve the claim path for the current pool state. Pure: same input ⇒ same
 * output, no IO, no clock.
 */
export function decideClaimPath(input: CutoverGateInput): CutoverDecision {
  // (1) Flag off → legacy bus, byte-for-byte today's behavior.
  if (!input.enabled) {
    return { path: 'bus', journalDryRun: false, reason: 'flag-off', incoherentPeers: [] };
  }

  // Consider only ONLINE peers — an offline peer cannot claim/broadcast right
  // now, so it neither blocks coherence nor participates in it (it will be
  // re-evaluated when it returns and re-advertises).
  const onlinePeers = input.peers.filter((p) => p.online !== false);

  // (2) No online peers → single-machine (or all-peers-dark) strict no-op. The
  // legacy path is the no-op baseline; with no peers there is no one to
  // double-run against, so the cutover is irrelevant.
  if (onlinePeers.length === 0) {
    return { path: 'bus', journalDryRun: false, reason: 'single-machine', incoherentPeers: [] };
  }

  // (3) Flag coherence: EVERY online peer must advertise ws43JournalLease.
  // Absent/false = does not advertise (the conservative side — invariant-5).
  const incoherentPeers = onlinePeers
    .filter((p) => p.ws43JournalLease !== true)
    .map((p) => p.machineId);

  if (incoherentPeers.length > 0) {
    // Mixed pool → stay on the bus for the WHOLE job set. Never lease while a
    // peer broadcasts: the named migration hazard. Degrade conservatively.
    return { path: 'bus', journalDryRun: false, reason: 'peers-incoherent', incoherentPeers };
  }

  // Coherent pool. Dry-run still runs the bus path but logs the intended claim.
  if (input.dryRun) {
    return { path: 'bus', journalDryRun: true, reason: 'dry-run', incoherentPeers: [] };
  }

  return { path: 'journal', journalDryRun: false, reason: 'journal-coherent', incoherentPeers: [] };
}

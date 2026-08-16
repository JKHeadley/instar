/**
 * ServeFailoverEngine — the §5.3 quota-aware automatic seat-transfer FAILOVER loop
 * for the cross-machine account & quota sharing feature (spec:
 * docs/specs/cross-machine-account-quota-sharing.md §5.3, governed by D4/D7/D8/D10/D11).
 *
 * THE CORE BEHAVIOR: on an inbound for a topic whose CURRENT OWNER cannot serve
 * (its own `canServe:false` for that topic's channel) and a peer CAN, fire the
 * already-proven `POST /pool/transfer` to an `online + canServe:true` peer. The
 * destination admits the resumed session through ITS OWN guards and REVALIDATES
 * serveability at admission (the transfer planner + the destination's quota gate);
 * a `cannot-serve` bounce falls to the next candidate (bounded), then to honest
 * degradation (§5.4).
 *
 * WHY this rides /pool/transfer (D7 + Structure>Willpower): the transfer planner
 * already runs over the signed mesh RPC path (recipient-bound + nonce + RBAC),
 * already inherits the autonomous-run-suspend behavior (D11), and already validates
 * online/already-there. We do NOT invent a parallel serve-routing path.
 *
 * DESIGN INVARIANTS this module enforces:
 *  - D4 hysteresis: a seat may not move again within `minSeatDwellMs`; a recovered
 *    owner-account does not snap the seat back until a debounce window; a per-source
 *    concurrency cap; a per-destination bounce cooldown.
 *  - D8: `canServe` is an advisory FILTER, never authority — admission revalidates.
 *  - D10 fail-open CONDITIONED on local serveability: (a) local owner CAN serve +
 *    machinery uncertain ⇒ owner serves (safe no-op); (b) local owner CANNOT serve
 *    (certain) + failover uncertain ⇒ honest degradation, NEVER a silent local attempt.
 *  - D6 dry-run: when dryRun holds, the engine RECORDS every proposed transfer +
 *    decision but fires none.
 *  - Single-machine no-op is STRUCTURAL: the candidate set excludes self and is empty.
 *
 * The pure DECISION (`decideFailover`) is separated from the side-effecting
 * EXECUTOR (`ServeFailoverEngine.handleInbound`) so the decision boundary is
 * unit-testable without any transfer I/O.
 */

import type { MachineCapacity } from './types.js';
import { resolveCanServe } from './serveCapability.js';
import type { ServeRequirement } from './serveCapability.js';

// ── Tunables (config-resolved; defaults per §4/§5.3) ──────────────────

export interface ServeFailoverPolicy {
  /** D4: minimum seat-dwell before a seat may move again (ms). */
  minSeatDwellMs: number;
  /** D4: heartbeat intervals a recovered owner-account must stay non-walled before
   *  it counts as recovered for seat-pull purposes. */
  recoveredDebounceHeartbeats: number;
  /** The heartbeat interval the debounce is measured in (ms). */
  heartbeatIntervalMs: number;
  /** D8/§5.3: max candidates tried for one inbound before honest degradation. */
  maxAdmissionAttempts: number;
  /** §5.3 herd: max concurrent in-flight failovers FROM this machine as source. */
  maxConcurrentFailoversPerSource: number;
  /** §5.3 herd: per-destination cooldown after a cannot-serve bounce (ms). */
  bounceCooldownMs: number;
}

export const DEFAULT_SERVE_FAILOVER_POLICY: ServeFailoverPolicy = {
  minSeatDwellMs: 60_000, // reuse SpeakerElection.DEFAULT_DWELL_MS
  recoveredDebounceHeartbeats: 2,
  heartbeatIntervalMs: 30_000,
  maxAdmissionAttempts: 3,
  maxConcurrentFailoversPerSource: 3,
  bounceCooldownMs: 30_000,
};

/** Clamp a partial config into a full policy (defensive; numeric-safe — uses ??). */
export function resolveServeFailoverPolicy(
  cfg:
    | {
        minSeatDwellMs?: number;
        recoveredDebounceHeartbeats?: number;
        heartbeatIntervalMs?: number;
        maxAdmissionAttempts?: number;
        maxConcurrentFailoversPerSource?: number;
        bounceCooldownMs?: number;
      }
    | undefined,
): ServeFailoverPolicy {
  const d = DEFAULT_SERVE_FAILOVER_POLICY;
  return {
    minSeatDwellMs: Math.max(0, cfg?.minSeatDwellMs ?? d.minSeatDwellMs),
    recoveredDebounceHeartbeats: Math.max(0, cfg?.recoveredDebounceHeartbeats ?? d.recoveredDebounceHeartbeats),
    heartbeatIntervalMs: Math.max(1_000, cfg?.heartbeatIntervalMs ?? d.heartbeatIntervalMs),
    maxAdmissionAttempts: Math.max(1, cfg?.maxAdmissionAttempts ?? d.maxAdmissionAttempts),
    maxConcurrentFailoversPerSource: Math.max(1, cfg?.maxConcurrentFailoversPerSource ?? d.maxConcurrentFailoversPerSource),
    bounceCooldownMs: Math.max(0, cfg?.bounceCooldownMs ?? d.bounceCooldownMs),
  };
}

// ── The pure decision ─────────────────────────────────────────────────

/** The inputs the pure decision reads — all already-resolved, no I/O. */
export interface FailoverDecisionInput {
  /** The topic whose inbound triggered this. */
  topicId: string;
  /** The conversation's channel requirement (platform + chat/workspace). */
  requirement: ServeRequirement | undefined;
  /** This machine's id (excluded from candidates — the single-machine no-op). */
  selfMachineId: string | null;
  /** The CURRENT owner of the topic (the machine whose canServe gates the decision).
   *  Null = no recorded owner → treat self as owner. */
  currentOwner: string | null;
  /** The full pool view (self + peers). */
  machines: MachineCapacity[];
  /** Whether the LOCAL owner (self) can certainly serve this topic — derived from
   *  self's OWN live signal, NOT a heartbeat (D10: certainty about SELF). */
  localOwnerCanServe: boolean;
  /** Whether the LOCAL owner's serveability is CERTAIN (we positively observed it).
   *  When false, the local serveability is uncertain (D10 fail-open inputs differ). */
  localOwnerServeabilityCertain: boolean;
  /** Per-destination cooldown-until map (machineId → epoch ms) from prior bounces. */
  destCooldownUntil: Map<string, number>;
  /** Number of in-flight failovers currently sourced from this machine. */
  inFlightFromSource: number;
  /** Last time this topic's seat moved (epoch ms) or null. */
  lastSeatMoveAtMs: number | null;
  /** Wall clock. */
  nowMs: number;
  policy: ServeFailoverPolicy;
}

export type FailoverAction =
  | 'no-action-owner-serves' // owner can serve → nothing to do (the common case)
  | 'transfer' // fire a transfer to `chosenCandidate`
  | 'honest-degradation' // no peer can serve → §5.4
  | 'defer-dwell' // D4: within seat-dwell window, hold
  | 'defer-source-cap' // §5.3: source concurrency cap saturated, defer to next tick
  | 'no-action-single-machine'; // structural no-op (no peers)

export interface FailoverDecision {
  action: FailoverAction;
  /** The chosen destination machineId for a `transfer`. */
  chosenCandidate?: string;
  /** The ordered candidate list (best-first) — used to try-next on admission bounce. */
  candidates: string[];
  /** A typed, non-free-text reason category for the audit trail. */
  reason: string;
}

/**
 * Score a candidate for failover selection (lower = better): the SAME placement
 * inputs (load + session ratio + mem pressure) PLUS an in-flight-failover spread
 * term so consecutive picks diverge across eligible peers rather than herding.
 */
function candidateScore(m: MachineCapacity, inFlightToDest: number): number {
  const load = m.loadAvg ?? 0;
  const ratio = m.maxSessions && m.maxSessions > 0 ? (m.activeSessionCount ?? 0) / m.maxSessions : 0;
  const memNum: Record<string, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
  const mem = memNum[m.memPressure ?? 'low'] ?? 0;
  // Weights mirror the placement scorer's spirit; the in-flight term (W=5) is the
  // herd-spread the spec calls for so two consecutive picks diverge.
  return 1 * load + 2 * ratio + 1 * mem + 5 * inFlightToDest;
}

/**
 * The pure failover decision (§5.3 + D4/D10). Deterministic over its inputs.
 *
 * @param inFlightToDest (machineId → count) optional spread input for scoring.
 */
export function decideFailover(
  input: FailoverDecisionInput,
  inFlightToDest: Map<string, number> = new Map(),
): FailoverDecision {
  const { selfMachineId, currentOwner, machines, policy, nowMs } = input;
  const owner = currentOwner ?? selfMachineId;

  // 1. Resolve whether the OWNER can serve this topic's channel.
  //    For the LOCAL owner (owner === self) we use the CERTAIN live signal (D10),
  //    not the heartbeat advert. For a remote owner, use its advertised summary.
  let ownerCanServe: boolean;
  if (owner != null && owner === selfMachineId) {
    ownerCanServe = input.localOwnerCanServe;
  } else {
    const ownerCap = machines.find((m) => m.machineId === owner) ?? null;
    ownerCanServe = resolveCanServe(ownerCap?.canServe, input.requirement).canServe;
  }

  // 2. If the owner CAN serve → no failover. (The common, safe path.)
  if (ownerCanServe) {
    return { action: 'no-action-owner-serves', candidates: [], reason: 'owner-can-serve' };
  }

  // 3. The owner CANNOT serve. D10 fail-open posture, conditioned on LOCAL certainty:
  //    (a) If the owner is the LOCAL machine AND its non-serveability is UNCERTAIN,
  //        the safe direction is to let the owner try (do NOT route on a guess). This
  //        is the "local CAN serve + uncertain ⇒ owner serves" branch generalized:
  //        we only failover off the local machine when we are CERTAIN it cannot serve.
  if (owner != null && owner === selfMachineId && !input.localOwnerServeabilityCertain) {
    return { action: 'no-action-owner-serves', candidates: [], reason: 'local-serveability-uncertain-owner-serves' };
  }

  // 4. D4 hysteresis: do not move the seat again within the dwell window.
  if (input.lastSeatMoveAtMs != null && nowMs - input.lastSeatMoveAtMs < policy.minSeatDwellMs) {
    return { action: 'defer-dwell', candidates: [], reason: 'within-seat-dwell-window' };
  }

  // 5. Build the candidate set: online + canServe:true + channel-reachable peers,
  //    EXCLUDING self (the single-machine no-op is structural here) and the current
  //    owner, and excluding any peer in its bounce-cooldown window.
  const eligible = machines.filter((m) => {
    if (m.machineId === selfMachineId) return false; // never self
    if (m.machineId === owner) return false; // not the owner that can't serve
    if (!m.online) return false;
    if (m.clockSkewStatus === 'suspect-clock-removed') return false;
    const cd = input.destCooldownUntil.get(m.machineId);
    if (cd != null && cd > nowMs) return false; // in bounce-cooldown
    return resolveCanServe(m.canServe, input.requirement).canServe;
  });

  // 6. No eligible peer → honest degradation (§5.4). This is also the structural
  //    single-machine no-op: with no peers the eligible set is empty.
  if (eligible.length === 0) {
    return {
      action: machines.length <= 1 ? 'no-action-single-machine' : 'honest-degradation',
      candidates: [],
      reason: machines.length <= 1 ? 'single-machine-pool' : 'no-peer-can-serve',
    };
  }

  // 7. §5.3 source-concurrency cap: if this machine already has the max in-flight
  //    failovers, defer to the next tick (the inbound stays queued per D13).
  if (input.inFlightFromSource >= policy.maxConcurrentFailoversPerSource) {
    return { action: 'defer-source-cap', candidates: eligible.map((m) => m.machineId), reason: 'source-concurrency-cap-saturated' };
  }

  // 8. Order candidates best-first (load + herd-spread), cap to maxAdmissionAttempts.
  const ordered = [...eligible]
    .sort((a, b) => candidateScore(a, inFlightToDest.get(a.machineId) ?? 0) - candidateScore(b, inFlightToDest.get(b.machineId) ?? 0))
    .map((m) => m.machineId)
    .slice(0, policy.maxAdmissionAttempts);

  return { action: 'transfer', chosenCandidate: ordered[0], candidates: ordered, reason: 'owner-walled-peer-can-serve' };
}

// ── The side-effecting executor ───────────────────────────────────────

/** One audit record per routing decision (§10 — logs/serve-failover.jsonl). */
export interface ServeFailoverAuditRecord {
  ts: string;
  topicId: string;
  from: string | null;
  to: string | null;
  action: FailoverAction;
  reason: string;
  /** Outcome of the attempt (set after execution). */
  outcome:
    | 'transferred'
    | 'dry-run'
    | 'bounced-tried-next'
    | 'exhausted-degraded'
    | 'no-action'
    | 'deferred'
    | 'error';
  dryRun: boolean;
  /** The ownership epoch observed at decision time (fencing). */
  epoch?: number;
  detail?: string;
}

/** The result of executing a transfer against a single candidate (admission revalidation). */
export interface TransferAttemptResult {
  /** True when the destination ADMITTED + the transfer landed. */
  ok: boolean;
  /** A 'cannot-serve' bounce (the destination revalidated and refused) → try next. */
  bounced: boolean;
  /** Honest detail for the audit (never a raw token / peer free-text). */
  detail?: string;
}

export interface ServeFailoverEngineDeps {
  /** Resolve THIS machine's id (null on a non-pool install → structural no-op). */
  selfMachineId: () => string | null;
  /** The current pool view (self + peers). */
  getMachines: () => MachineCapacity[];
  /** The current owner of a topic, or null. */
  ownerOf: (topicId: string) => string | null;
  /** The ownership epoch for a topic (fencing) — 0 when unknown. */
  ownershipEpoch: (topicId: string) => number;
  /** Whether the feature is enabled (resolveDevAgentGate live per call). */
  isEnabled: () => boolean;
  /** Whether dry-run holds (default true — the canary). */
  isDryRun: () => boolean;
  /** This machine's CERTAIN live serveability for a topic (D10) →
   *  `{ canServe, certain }`. Derived from self's OWN live circuit/quota, never a
   *  heartbeat advert. */
  localServeability: (topicId: string, requirement: ServeRequirement | undefined) => { canServe: boolean; certain: boolean };
  /** Execute a transfer to a candidate via the proven POST /pool/transfer path
   *  (signed mesh RPC, D7). The destination revalidates at admission (D8). Returns
   *  ok / bounced(try-next) / failed. Only called when NOT dry-run. */
  executeTransfer: (topicId: string, toMachineId: string, epoch: number) => Promise<TransferAttemptResult>;
  /** Emit the §5.4 honest-degradation notice for a walled episode (called when no
   *  peer can serve). Idempotent per (topic, episode) inside the notice manager. */
  emitHonestDegradation: (topicId: string, requirement: ServeRequirement | undefined) => Promise<void> | void;
  /** Append one audit record (logs/serve-failover.jsonl). */
  audit: (rec: ServeFailoverAuditRecord) => void;
  /** Record that a serve-failover routing decision was OBSERVED (observability key
   *  'serve-failover'), with the engaged/found-server/no-server sub-outcome. */
  recordMetric?: (outcome: 'engaged' | 'found-server' | 'no-server' | 'whole-pool-walled') => void;
  policy: ServeFailoverPolicy;
  now?: () => number;
}

export class ServeFailoverEngine {
  private readonly d: ServeFailoverEngineDeps;
  /** Per-topic last seat-move time (D4 dwell). */
  private readonly lastSeatMoveAt = new Map<string, number>();
  /** Per-destination cooldown-until (epoch ms) from a cannot-serve bounce. */
  private readonly destCooldownUntil = new Map<string, number>();
  /** Topics with an in-flight failover (single-flight per topic). */
  private readonly inFlight = new Set<string>();

  constructor(deps: ServeFailoverEngineDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Test/observability accessor: the count of in-flight failovers from this source. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Handle an inbound for a topic: decide + (when warranted) execute the failover.
   * STRICT no-op when the feature resolves dark. Single-flight per topic. Never
   * throws to the caller — every error path is recorded and fails toward the safe
   * direction (the owner keeps serving / honest degradation).
   */
  async handleInbound(topicId: string, requirement: ServeRequirement | undefined): Promise<FailoverDecision> {
    // STRICT no-op while dark (the whole layer is inert).
    if (!this.d.isEnabled()) {
      return { action: 'no-action-owner-serves', candidates: [], reason: 'feature-disabled' };
    }
    // Single-flight per topic — a second inbound while a transfer is in flight defers.
    if (this.inFlight.has(topicId)) {
      return { action: 'defer-source-cap', candidates: [], reason: 'transfer-already-in-flight-for-topic' };
    }

    const selfMachineId = this.d.selfMachineId();
    const machines = this.d.getMachines();
    const currentOwner = this.d.ownerOf(topicId);
    const local = this.d.localServeability(topicId, requirement);

    const decision = decideFailover({
      topicId,
      requirement,
      selfMachineId,
      currentOwner,
      machines,
      localOwnerCanServe: local.canServe,
      localOwnerServeabilityCertain: local.certain,
      destCooldownUntil: this.destCooldownUntil,
      inFlightFromSource: this.inFlight.size,
      lastSeatMoveAtMs: this.lastSeatMoveAt.get(topicId) ?? null,
      nowMs: this.now(),
      policy: this.d.policy,
    });

    const epoch = this.d.ownershipEpoch(topicId);
    const baseRec = {
      ts: new Date(this.now()).toISOString(),
      topicId,
      from: currentOwner ?? selfMachineId,
      dryRun: this.d.isDryRun(),
      epoch,
    };

    // Branch on the decision.
    if (decision.action === 'no-action-owner-serves' || decision.action === 'no-action-single-machine') {
      // No audit noise for the common owner-serves path UNLESS it's the structural
      // single-machine no-op which is worth one breadcrumb at debug time only — skip.
      return decision;
    }

    if (decision.action === 'defer-dwell' || decision.action === 'defer-source-cap') {
      this.d.audit({ ...baseRec, to: null, action: decision.action, reason: decision.reason, outcome: 'deferred' });
      return decision;
    }

    if (decision.action === 'honest-degradation') {
      this.d.recordMetric?.('whole-pool-walled');
      try {
        await this.d.emitHonestDegradation(topicId, requirement);
      } catch (err) {
        // NOT silent: recorded as an error outcome; the inbound stays queued on the
        // owner (§5.4) regardless — the safe direction.
        this.d.audit({ ...baseRec, to: null, action: decision.action, reason: decision.reason, outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
        return decision;
      }
      this.d.audit({ ...baseRec, to: null, action: decision.action, reason: decision.reason, outcome: 'exhausted-degraded' });
      return decision;
    }

    // decision.action === 'transfer'
    this.d.recordMetric?.('engaged');

    // DRY-RUN (D6): record the PROPOSED transfer + destination; perform none.
    if (this.d.isDryRun()) {
      this.d.audit({ ...baseRec, to: decision.chosenCandidate ?? null, action: 'transfer', reason: decision.reason, outcome: 'dry-run', detail: `candidates=${decision.candidates.join(',')}` });
      return decision;
    }

    // LIVE: try candidates in order; admission revalidates (D8); bounce → next.
    this.inFlight.add(topicId);
    try {
      for (const cand of decision.candidates) {
        let res: TransferAttemptResult;
        try {
          res = await this.d.executeTransfer(topicId, cand, epoch);
        } catch (err) {
          this.d.audit({ ...baseRec, to: cand, action: 'transfer', reason: decision.reason, outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
          // An execution error on this candidate behaves like a bounce → next.
          this.destCooldownUntil.set(cand, this.now() + this.d.policy.bounceCooldownMs);
          continue;
        }
        if (res.ok) {
          this.lastSeatMoveAt.set(topicId, this.now());
          this.d.recordMetric?.('found-server');
          this.d.audit({ ...baseRec, to: cand, action: 'transfer', reason: decision.reason, outcome: 'transferred', detail: res.detail });
          return { ...decision, chosenCandidate: cand };
        }
        // Bounced (cannot-serve at admission, D8) → cooldown the dest, try next.
        this.destCooldownUntil.set(cand, this.now() + this.d.policy.bounceCooldownMs);
        this.d.audit({ ...baseRec, to: cand, action: 'transfer', reason: decision.reason, outcome: 'bounced-tried-next', detail: res.detail });
        if (!res.bounced) {
          // A non-bounce failure (e.g. offline target) — also try next; the cooldown
          // is already set. Continue the loop.
        }
      }
      // All candidates exhausted → honest degradation (§5.4).
      this.d.recordMetric?.('no-server');
      try {
        await this.d.emitHonestDegradation(topicId, requirement);
      } catch (err) {
        this.d.audit({ ...baseRec, to: null, action: 'honest-degradation', reason: 'all-candidates-bounced', outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
        return { action: 'honest-degradation', candidates: decision.candidates, reason: 'all-candidates-bounced' };
      }
      this.d.audit({ ...baseRec, to: null, action: 'honest-degradation', reason: 'all-candidates-bounced', outcome: 'exhausted-degraded' });
      return { action: 'honest-degradation', candidates: decision.candidates, reason: 'all-candidates-bounced' };
    } finally {
      this.inFlight.delete(topicId);
    }
  }
}

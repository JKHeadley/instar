/**
 * OwnershipReconciler — WS1.3 of MULTI-MACHINE-SEAMLESSNESS-SPEC: a pin that
 * disagrees with ownership is a first-class PENDING state with a BOUNDED
 * convergence path, instead of an indefinite divergence that waits for an
 * inbound message that may never route (the 2026-06-12 live incident: topic
 * 13481 sat owner=Mini / pin=Laptop for hours; the closeout reaper attacked the
 * working session the whole time).
 *
 * Each machine runs its own reconciler over LOCAL replicated state (pins are
 * router-write-only on this machine's disk; ownership reads are the local CAS
 * registry view) — never a mesh call on the tick path. Convergence is the
 * cooperative FSM handoff whenever the owner is alive:
 *
 *   owner sees conflicting pin → (debounce, safe point, bounded) → CAS
 *   transfer→(pin target) → target's reconciler sees transferring-to-me → CAS
 *   claim → active. Claim-before-release; exactly-one-owner by the epoch fence.
 *
 * The FORCE path exists only for a PROVABLY DEAD owner: pool capacity offline
 * with last-seen older than the death-evidence bound AND quorum membership
 * (Phase C: online > total/2 for N-machine pools; a 2-machine pool degrades to
 * the surviving machine when its peer is provably dark — documented, since
 * majority-of-2 cannot lose a member). A reachable-but-slow owner is NEVER
 * force-claimed — that direction of error (stealing a live conversation
 * mid-turn) is the round-2 adversarial finding this design closed.
 *
 * Provenance: the pin store is written ONLY by the authenticated router
 * transfer path on this machine — a peer cannot write this machine's pin file,
 * and journal-replicated placement entries are evidence, never triggers. The
 * reconciler acts only on its OWN pin store (L15: reach ≠ authority).
 *
 * Posture (spec §7): the reconciler is per-machine BY DESIGN (each machine
 * reconciles its own view; the CAS registry is the shared arbiter). Ships DARK
 * behind multiMachine.seamlessness.ws13Reconcile with dryRun=true default
 * (logs intended actions without CAS). Single-machine pools: strict no-op —
 * the tick returns before touching any machinery when fewer than 2 machines
 * are registered.
 */

import type { SessionOwnershipRegistry, CasResult } from './SessionOwnershipRegistry.js';
import type { SessionOwnershipRecord } from './SessionOwnership.js';
import type { TopicPlacementPinStore } from './TopicPlacementPinStore.js';

export interface ReconcilerMachineView {
  machineId: string;
  online: boolean;
  /** ms since epoch of the machine's last self-reported heartbeat (0 = never). */
  lastSeenMs: number;
}

export interface OwnershipReconcilerDeps {
  /** Dark flag — read live each tick. */
  enabled: () => boolean;
  /** Dry-run — log intended actions, never CAS. Read live. */
  dryRun: () => boolean;
  selfMachineId: string;
  pinStore: TopicPlacementPinStore;
  ownership: SessionOwnershipRegistry;
  /** All REGISTERED machines (online and not). [] or [self] → strict no-op. */
  machines: () => ReconcilerMachineView[];
  /**
   * Safe-point check: is the topic's local session mid-turn right now?
   * Busy → defer the cooperative release until idle OR until safePointDeadlineMs
   * has elapsed since the conflict was first observed (the spec's bounded
   * "next safe point": end of turn or T seconds, whichever first).
   */
  isTopicBusy: (sessionKey: string) => boolean;
  /** Journal pairing (§3.3): every landed CAS emits a placement entry. */
  emitPlacement: (sessionKey: string, r: CasResult & { ok: true }, reason: 'reconcile-transfer' | 'reconcile-claim' | 'reconcile-force-claim' | 'reconcile-adopt') => void;
  /** Pin must be stable this long before the owner acts (flap debounce). */
  debounceMs?: number;
  /** Bounded safe-point wait: after this, transfer even if the session is busy. */
  safePointDeadlineMs?: number;
  /** Owner-death evidence: offline AND lastSeen older than this. */
  deathEvidenceMs?: number;
  now?: () => number;
  logger?: (msg: string) => void;
}

export interface ReconcileTickReport {
  examined: number;
  transfers: number;
  claims: number;
  forceClaims: number;
  adoptions: number;
  deferredBusy: number;
  deferredDebounce: number;
  deferredNoEvidence: number;
  dryRun: boolean;
  skipped?: 'disabled' | 'single-machine';
}

const DEFAULT_DEBOUNCE_MS = 30_000;
/** WS1.2 drain-grace: hold the transferring-to-me claim back long enough for a
 *  LIVE owner's bounded drain (SessionDrainRunner) to finish and land the claim
 *  itself — the reconciler claim is the BACKSTOP for an owner that died
 *  mid-drain, never the front-runner that releases the inbound barrier before
 *  the old session reached its turn boundary. Mirrors
 *  DEFAULT_DRAIN_CLAIM_GRACE_MS (drain bound 30s + 15s close/CAS slack). */
const DEFAULT_DRAIN_CLAIM_GRACE_MS = 45_000;
const DEFAULT_SAFE_POINT_DEADLINE_MS = 120_000;
const DEFAULT_DEATH_EVIDENCE_MS = 180_000;

export class OwnershipReconciler {
  private readonly d: OwnershipReconcilerDeps;
  /** First time we observed each topic's CURRENT conflict (cleared on convergence). */
  private readonly conflictSince = new Map<string, number>();

  constructor(deps: OwnershipReconcilerDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private log(msg: string): void {
    try { this.d.logger?.(`[OwnershipReconciler] ${msg}`); } catch { /* observability never gates */ }
  }

  /**
   * One reconcile pass. Deterministic over local state; bounded by the number
   * of pinned topics. Safe to call on any cadence.
   */
  tick(): ReconcileTickReport {
    const report: ReconcileTickReport = {
      examined: 0, transfers: 0, claims: 0, forceClaims: 0, adoptions: 0,
      deferredBusy: 0, deferredDebounce: 0, deferredNoEvidence: 0,
      dryRun: this.d.dryRun(),
    };
    if (!this.d.enabled()) {
      report.skipped = 'disabled';
      return report;
    }
    const machines = this.d.machines();
    if (machines.length < 2) {
      // Spec invariant 6: single-machine strict no-op — no machinery entered.
      report.skipped = 'single-machine';
      return report;
    }
    const now = this.now();
    const self = this.d.selfMachineId;
    const byId = new Map(machines.map((m) => [m.machineId, m]));

    for (const [sessionKey, pin] of Object.entries(this.d.pinStore.all())) {
      if (!pin.pinned || !pin.preferredMachine) continue;
      const rec = this.d.ownership.read(sessionKey);
      const owner = rec && rec.status !== 'released' ? rec.ownerMachineId : null;
      if (owner === pin.preferredMachine && rec?.status === 'active') {
        this.conflictSince.delete(sessionKey);
        continue; // converged
      }
      report.examined++;
      if (!this.conflictSince.has(sessionKey)) this.conflictSince.set(sessionKey, now);
      const since = this.conflictSince.get(sessionKey)!;

      // ── Case B: a transfer is mid-flight TO ME → claim (completes the handoff).
      // WS1.2 drain-grace: a FRESH drain-flow transferring record
      // (drainInFlight) means the owner's SessionDrainRunner is still running
      // — it lands the claim itself at drain completion. The reconciler claims
      // only past the grace (the owner died mid-drain). Reconciler-cooperative
      // transfers (no flag) claim promptly — the owner already waited for a
      // safe point before transferring.
      if (rec?.status === 'transferring' && rec.transferTo === self) {
        if (rec.drainInFlight === true && now - (rec.timestamp ?? 0) < DEFAULT_DRAIN_CLAIM_GRACE_MS) {
          report.deferredBusy++;
          continue;
        }
        this.act(report, 'claims', sessionKey, { type: 'claim', machineId: self }, 'reconcile-claim');
        continue;
      }
      if (rec?.status === 'transferring') continue; // someone else's claim to make

      // ── Case D: no live record and the pin names ME → adopt (place→claim).
      if ((!rec || rec.status === 'released') && pin.preferredMachine === self) {
        const placed = this.act(report, 'adoptions', sessionKey, { type: 'place', machineId: self }, 'reconcile-adopt');
        if (placed) this.act(report, 'adoptions', sessionKey, { type: 'claim', machineId: self }, 'reconcile-adopt', /*countOnce*/ true);
        continue;
      }
      if (!rec || rec.status === 'released') continue;

      // From here the record is active with owner ≠ pin target.
      // ── Case A: I am the live owner → cooperative transfer at a safe point.
      if (owner === self) {
        // Flap debounce: the pin must be stable before the owner gives up custody.
        const pinAgeMs = now - Date.parse(pin.updatedAt);
        if (Number.isFinite(pinAgeMs) && pinAgeMs < (this.d.debounceMs ?? DEFAULT_DEBOUNCE_MS)) {
          report.deferredDebounce++;
          continue;
        }
        // Bounded safe point: wait for idle, but never past the deadline.
        const busy = this.d.isTopicBusy(sessionKey);
        const pastDeadline = now - since >= (this.d.safePointDeadlineMs ?? DEFAULT_SAFE_POINT_DEADLINE_MS);
        if (busy && !pastDeadline) {
          report.deferredBusy++;
          continue;
        }
        this.act(report, 'transfers', sessionKey, { type: 'transfer', to: pin.preferredMachine }, 'reconcile-transfer');
        continue;
      }

      // ── Case C: the pin names ME but a DEAD machine holds the record → force.
      if (pin.preferredMachine === self) {
        const ownerView = owner ? byId.get(owner) : undefined;
        const ownerProvablyDead = !!ownerView
          && !ownerView.online
          && (now - ownerView.lastSeenMs) >= (this.d.deathEvidenceMs ?? DEFAULT_DEATH_EVIDENCE_MS);
        // Owner not even REGISTERED → it cannot heartbeat or hold a lease here;
        // treat as dead only with the same age discipline (no view = no liveness
        // proof; lastSeenMs 0 satisfies the age bound trivially, which is right:
        // a machine the pool has never seen cannot be the live owner).
        const ownerUnknown = !!owner && !ownerView;
        // Quorum (Phase C — N machines): act only from the majority partition.
        // total ≤ 2 degrades to "the surviving machine proceeds against a
        // provably dark peer" (majority-of-2 cannot lose a member; documented).
        const online = machines.filter((m) => m.online).length;
        const inQuorum = machines.length <= 2 || online * 2 > machines.length;
        if ((ownerProvablyDead || ownerUnknown) && inQuorum) {
          this.act(report, 'forceClaims', sessionKey, { type: 'force-claim', machineId: self }, 'reconcile-force-claim');
        } else {
          // Alive (or merely slow / unproven) owner: its own reconciler runs
          // Case A. We surface the pending state and wait — never steal.
          report.deferredNoEvidence++;
        }
        continue;
      }
      // Neither owner nor pin target: not my move this tick.
    }
    return report;
  }

  private act(
    report: ReconcileTickReport,
    counter: 'transfers' | 'claims' | 'forceClaims' | 'adoptions',
    sessionKey: string,
    action: Parameters<SessionOwnershipRegistry['cas']>[0],
    reason: 'reconcile-transfer' | 'reconcile-claim' | 'reconcile-force-claim' | 'reconcile-adopt',
    countOnce = false,
  ): boolean {
    if (this.d.dryRun()) {
      this.log(`DRY-RUN would ${action.type} ${sessionKey} (${reason})`);
      if (!countOnce) report[counter]++;
      return false; // dry-run never lands a CAS, so chained steps stop here
    }
    const r = this.d.ownership.cas(action, {
      sessionKey,
      sender: this.d.selfMachineId,
      nonce: `${this.d.selfMachineId}:${reason}:${sessionKey}:${this.now()}`,
    });
    if (r.ok) {
      if (!countOnce) report[counter]++;
      this.log(`${action.type} landed for ${sessionKey} (${reason}, epoch ${r.record.ownershipEpoch})`);
      try { this.d.emitPlacement(sessionKey, r, reason); } catch { /* §3.3 pairing is observability — never endangers the CAS */ }
      this.conflictSince.delete(sessionKey);
      return true;
    }
    this.log(`${action.type} rejected for ${sessionKey} (${'reason' in r ? r.reason : 'unknown'}) — will re-evaluate next tick`);
    return false;
  }
}

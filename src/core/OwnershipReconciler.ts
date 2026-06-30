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
import type { TopicPin, TopicPlacementPinStore } from './TopicPlacementPinStore.js';
import { compareHlc } from './TopicPinReplicatedStore.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';

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
  /**
   * This machine's mesh id, LATE-BOUND (Finding 2026-06-30: the boot-ordering bug the
   * live proof caught). In server.ts the reconciler is wired ~950 lines BEFORE `_meshSelfId`
   * is assigned, so a value here would always be null → the reconciler was never built and
   * never ticked. A getter is read at TICK time (by which point the id resolves), exactly the
   * pattern the sibling OwnershipApplier already uses (ownership-applier-meshself-ordering-fix).
   * A tick while it is still null is a strict no-op (treated like single-machine).
   */
  selfMachineId: () => string | null;
  /**
   * The local pin store, LATE-BOUND (Finding 2026-06-30 #2, the live proof's SECOND catch):
   * in server.ts `_topicPinStore` is assigned ~2200 lines AFTER the reconciler is wired, so a
   * value here (and the old `if (_topicPinStore)` construction gate) was ALWAYS null → the
   * reconciler still never built even after the `_meshSelfId` fix. A getter read at TICK time
   * resolves the store once boot completes; a tick while it is still null yields no pins (a
   * natural no-op). Same late-bound pattern as `selfMachineId` + the sibling OwnershipApplier.
   */
  pinStore: () => TopicPlacementPinStore | null;
  /**
   * Cross-machine convergence (Fix #2): the merged ADVISORY replicated pins (move-intent
   * from peers, HLC-ordered). The OWNING machine has no LOCAL pin for a stuck move (the pin
   * was set on the lease-holder) — this is how it sees "you are pinned away" and starts the
   * cooperative transfer. ADVISORY only: validated (known+online target) and able to trigger
   * the owner's OWN transfer, never a force-claim. Absent ⇒ local-pin-only (single-machine
   * / un-wired), today's behavior. Each entry is `{preferredMachine, hlc}` for a pinned topic.
   */
  advisoryPins?: () => Map<number, { preferredMachine: string; hlc: HlcTimestamp }>;
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
  emitPlacement: (sessionKey: string, r: CasResult & { ok: true }, reason: 'reconcile-transfer' | 'reconcile-claim' | 'reconcile-force-claim' | 'reconcile-adopt' | 'reconcile-abort-transfer') => void;
  /** Fix #3 / Finding N4: how long a `transferring` may sit (from its `timestamp`) before
   *  the owner aborts a transfer toward an unreachable target. Default 120s. */
  transferDeadlineMs?: number;
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
  /** Fix #3 / Finding N4: a stuck `transferring(self→T)` whose target T went unreachable
   *  past the deadline was aborted back to active(self) — recovery, not a new stall. */
  aborts: number;
  deferredBusy: number;
  deferredDebounce: number;
  deferredNoEvidence: number;
  dryRun: boolean;
  skipped?: 'disabled' | 'single-machine' | 'self-id-unresolved';
}

/** Read-only per-topic decision explanation (Observable Intelligence): what the
 *  reconciler WOULD do for one topic right now, and why — for live debugging a
 *  stuck convergence without acting. Produced by OwnershipReconciler.explainTopic. */
export type ReconcileDecision =
  | 'no-pin' | 'converged' | 'claim' | 'await-other-claim' | 'adopt' | 'transfer'
  | 'deferred-debounce' | 'deferred-busy' | 'force-claim' | 'deferred-no-evidence'
  | 'abort-transfer' | 'not-my-move' | 'skipped';

export interface TopicReconcileExplanation {
  sessionKey: string;
  self: string;
  machinesCount: number;
  pinned?: boolean;
  preferredMachine?: string;
  owner?: string | null;
  status?: string | null;
  decision: ReconcileDecision;
  reason: string;
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
/** Fix #3 / Finding N4: how long a `transferring` may sit before the owner aborts a
 *  transfer toward an unreachable target (the convergence deadline). */
const DEFAULT_TRANSFER_DEADLINE_MS = 120_000;

export class OwnershipReconciler {
  private readonly d: OwnershipReconcilerDeps;
  /** First time we observed each topic's CURRENT conflict (cleared on convergence). */
  private readonly conflictSince = new Map<string, number>();
  /** Observability (Observable Intelligence): the most recent tick's report + when. */
  private lastReport: ReconcileTickReport | null = null;
  private lastTickAtMs = 0;

  constructor(deps: OwnershipReconcilerDeps) {
    this.d = deps;
  }

  /** Stamp the last-tick observability state and return the report (single funnel
   *  for every tick() exit so the status readout is never stale on an early return). */
  private finish(report: ReconcileTickReport): ReconcileTickReport {
    this.lastReport = report;
    this.lastTickAtMs = this.now();
    return report;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private log(msg: string): void {
    try { this.d.logger?.(`[OwnershipReconciler] ${msg}`); } catch { /* observability never gates */ }
  }

  /** The local pin's skew-proof HLC: its stored `hlc` (Fix #2), else a fallback derived
   *  from `updatedAt` (the migration for pre-Fix-#2 pins). */
  private deriveLocalPinHlc(pin: TopicPin): HlcTimestamp {
    if (pin.hlc) return pin.hlc;
    return { physical: Date.parse(pin.updatedAt) || 0, logical: 0, node: this.d.selfMachineId() ?? '' };
  }

  /**
   * The EFFECTIVE pin per topic = the union of LOCAL pins (authoritative on the machine
   * that set them) and ADVISORY replicated pins (the move-intent the OWNER receives),
   * resolved by HLC precedence (Finding N3): a stale LOCAL self-pin must never mask a
   * FRESHER replicated move-intent. With no advisory dep this is exactly the local pins
   * (today's behavior). A replicated pin is ADVISORY — it only ever yields a `preferredMachine`
   * the owner cooperatively transfers toward; the force-claim path never reads it.
   */
  private effectivePins(): Record<string, TopicPin> {
    const ps = this.d.pinStore();
    const local = ps ? ps.all() : {}; // null until _topicPinStore resolves at boot → no pins (natural no-op)
    const advisory = this.d.advisoryPins?.();
    if (!advisory || advisory.size === 0) return local;
    // Validate PRIMARY = membership/liveness (skew-proof): only act on a replicated pin
    // whose target is a KNOWN and currently-ONLINE machine (Findings N2/SE4/AD5). A stale
    // advisory pointing at a departed/offline machine must NOT trigger a transfer.
    const online = new Set(this.d.machines().filter((m) => m.online).map((m) => m.machineId));
    const out: Record<string, TopicPin> = { ...local };
    for (const [topic, adv] of advisory) {
      if (!online.has(adv.preferredMachine)) continue; // unknown/offline target → ignore advisory
      const key = String(topic);
      const localPin = local[key];
      const advPin: TopicPin = { preferredMachine: adv.preferredMachine, pinned: true, updatedAt: new Date(adv.hlc.physical).toISOString(), hlc: adv.hlc };
      if (!localPin || !localPin.pinned) {
        out[key] = advPin; // no authoritative local pin → advisory move-intent IS the effective pin
      } else if (compareHlc(adv.hlc, this.deriveLocalPinHlc(localPin)) > 0) {
        out[key] = advPin; // replicated intent is newer (HLC) → it wins (N3)
      }
    }
    return out;
  }

  /**
   * One reconcile pass. Deterministic over local state; bounded by the number
   * of pinned topics. Safe to call on any cadence.
   */
  tick(): ReconcileTickReport {
    const report: ReconcileTickReport = {
      examined: 0, transfers: 0, claims: 0, forceClaims: 0, adoptions: 0, aborts: 0,
      deferredBusy: 0, deferredDebounce: 0, deferredNoEvidence: 0,
      dryRun: this.d.dryRun(),
    };
    if (!this.d.enabled()) {
      report.skipped = 'disabled';
      return this.finish(report);
    }
    const machines = this.d.machines();
    if (machines.length < 2) {
      // Spec invariant 6: single-machine strict no-op — no machinery entered.
      report.skipped = 'single-machine';
      return this.finish(report);
    }
    const now = this.now();
    const self = this.d.selfMachineId();
    if (!self) {
      // The mesh id has not resolved yet (early boot). Strict no-op until it does — the
      // FSM decisions are all relative to "self", so acting without it would be unsound.
      report.skipped = 'self-id-unresolved';
      return this.finish(report);
    }
    const byId = new Map(machines.map((m) => [m.machineId, m]));

    for (const [sessionKey, pin] of Object.entries(this.effectivePins())) {
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
      if (rec?.status === 'transferring') {
        // ── N4 recovery: I am the draining SOURCE and my transfer TARGET went
        // unreachable past the deadline → abort-transfer back to active(self), so a
        // dead-target handoff self-heals instead of freezing the topic (the "don't
        // trade one stuck-state for another" finding). Owner-only by FSM construction.
        if (owner === self && rec.transferTo && rec.transferTo !== self) {
          const targetView = byId.get(rec.transferTo);
          const targetUnreachable = !targetView || !targetView.online;
          const pastDeadline = now - (rec.timestamp ?? now) >= (this.d.transferDeadlineMs ?? DEFAULT_TRANSFER_DEADLINE_MS);
          if (targetUnreachable && pastDeadline) {
            this.act(report, 'aborts', sessionKey, { type: 'abort-transfer', machineId: self }, 'reconcile-abort-transfer');
            continue;
          }
        }
        continue; // still in flight / someone else's claim to make
      }

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
    return this.finish(report);
  }

  private act(
    report: ReconcileTickReport,
    counter: 'transfers' | 'claims' | 'forceClaims' | 'adoptions' | 'aborts',
    sessionKey: string,
    action: Parameters<SessionOwnershipRegistry['cas']>[0],
    reason: 'reconcile-transfer' | 'reconcile-claim' | 'reconcile-force-claim' | 'reconcile-adopt' | 'reconcile-abort-transfer',
    countOnce = false,
  ): boolean {
    if (this.d.dryRun()) {
      this.log(`DRY-RUN would ${action.type} ${sessionKey} (${reason})`);
      if (!countOnce) report[counter]++;
      return false; // dry-run never lands a CAS, so chained steps stop here
    }
    const self = this.d.selfMachineId() ?? '';
    const r = this.d.ownership.cas(action, {
      sessionKey,
      sender: self,
      nonce: `${self}:${reason}:${sessionKey}:${this.now()}`,
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

  /**
   * Read-only diagnostic: what the reconciler decides for ONE topic right now, and
   * WHY — without acting. A documented mirror of tick()'s decision tree (kept in
   * lock-step by parity unit tests). Answers "why is topic N not converging?" live —
   * the exact gap that left the cross-machine stuck-move bug a black box (2026-06-30).
   */
  explainTopic(sessionKey: string): TopicReconcileExplanation {
    const self = this.d.selfMachineId() ?? '(mesh id unresolved)';
    const machines = this.d.machines();
    const base = { sessionKey, self, machinesCount: machines.length };
    if (!this.d.enabled()) return { ...base, decision: 'skipped', reason: 'reconciler disabled' };
    if (machines.length < 2) return { ...base, decision: 'skipped', reason: 'single-machine (machines() < 2)' };
    const pin = this.effectivePins()[sessionKey];
    if (!pin || !pin.pinned || !pin.preferredMachine) {
      return { ...base, decision: 'no-pin', reason: "no pinned preferredMachine (local or advisory replicated) for this topic" };
    }
    const rec = this.d.ownership.read(sessionKey);
    const owner = rec && rec.status !== 'released' ? rec.ownerMachineId : null;
    const ctx = { ...base, pinned: true as const, preferredMachine: pin.preferredMachine, owner, status: rec?.status ?? null };
    if (owner === pin.preferredMachine && rec?.status === 'active') {
      return { ...ctx, decision: 'converged', reason: 'owner == pin target and active' };
    }
    if (rec?.status === 'transferring' && rec.transferTo === self) {
      return { ...ctx, decision: 'claim', reason: 'transferring to me → would claim (completes handoff)' };
    }
    if (rec?.status === 'transferring') {
      const now0 = this.now();
      if (owner === self && rec.transferTo && rec.transferTo !== self) {
        const tv = machines.find((m) => m.machineId === rec.transferTo);
        const unreachable = !tv || !tv.online;
        const past = now0 - (rec.timestamp ?? now0) >= (this.d.transferDeadlineMs ?? DEFAULT_TRANSFER_DEADLINE_MS);
        if (unreachable && past) {
          return { ...ctx, decision: 'abort-transfer', reason: `transfer target ${rec.transferTo} unreachable past deadline → would abort back to active(self)` };
        }
      }
      return { ...ctx, decision: 'await-other-claim', reason: `transferring to ${rec.transferTo ?? '?'} — that machine claims` };
    }
    if ((!rec || rec.status === 'released') && pin.preferredMachine === self) {
      return { ...ctx, decision: 'adopt', reason: 'no live record + pin names me → would place→claim' };
    }
    if (!rec || rec.status === 'released') {
      return { ...ctx, decision: 'not-my-move', reason: 'no live record + pin names another machine' };
    }
    const now = this.now();
    if (owner === self) {
      const pinAgeMs = now - Date.parse(pin.updatedAt);
      const debounceMs = this.d.debounceMs ?? DEFAULT_DEBOUNCE_MS;
      if (Number.isFinite(pinAgeMs) && pinAgeMs < debounceMs) {
        return { ...ctx, decision: 'deferred-debounce', reason: `pin age ${Math.round(pinAgeMs)}ms < debounce ${debounceMs}ms` };
      }
      const since = this.conflictSince.get(sessionKey) ?? now;
      const busy = this.d.isTopicBusy(sessionKey);
      const pastDeadline = now - since >= (this.d.safePointDeadlineMs ?? DEFAULT_SAFE_POINT_DEADLINE_MS);
      if (busy && !pastDeadline) {
        return { ...ctx, decision: 'deferred-busy', reason: 'topic busy, within safe-point deadline' };
      }
      return { ...ctx, decision: 'transfer', reason: `I am the live owner, pin → ${pin.preferredMachine} → would transfer` };
    }
    if (pin.preferredMachine === self) {
      const byId = new Map(machines.map((m) => [m.machineId, m]));
      const ownerView = owner ? byId.get(owner) : undefined;
      const ownerProvablyDead = !!ownerView && !ownerView.online
        && (now - ownerView.lastSeenMs) >= (this.d.deathEvidenceMs ?? DEFAULT_DEATH_EVIDENCE_MS);
      const ownerUnknown = !!owner && !ownerView;
      const onlineCount = machines.filter((m) => m.online).length;
      const inQuorum = machines.length <= 2 || onlineCount * 2 > machines.length;
      if ((ownerProvablyDead || ownerUnknown) && inQuorum) {
        return { ...ctx, decision: 'force-claim', reason: 'pin names me + owner provably dead/unknown + in quorum' };
      }
      return { ...ctx, decision: 'deferred-no-evidence', reason: `pin names me but owner ${owner} is alive/unproven-dead (online=${ownerView?.online ?? 'unknown'}) — waiting for its own Case-A transfer` };
    }
    return { ...ctx, decision: 'not-my-move', reason: 'neither owner nor pin target this tick' };
  }

  /** Reconciler status (Observable Intelligence): last tick report + when, plus the
   *  live enabled/dryRun gate and machine-count the reconciler actually sees. */
  status(): {
    enabled: boolean;
    dryRun: boolean;
    lastTickAt: string | null;
    lastReport: ReconcileTickReport | null;
    machinesCount: number;
    selfMachineId: string | null;
  } {
    let machinesCount = 0;
    try { machinesCount = this.d.machines().length; } catch { /* best-effort */ }
    return {
      enabled: (() => { try { return !!this.d.enabled(); } catch { return false; } })(),
      dryRun: (() => { try { return !!this.d.dryRun(); } catch { return true; } })(),
      lastTickAt: this.lastTickAtMs ? new Date(this.lastTickAtMs).toISOString() : null,
      lastReport: this.lastReport,
      machinesCount,
      selfMachineId: this.d.selfMachineId(),
    };
  }
}

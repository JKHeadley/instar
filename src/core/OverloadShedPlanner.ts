/**
 * OverloadShedPlanner — Part D of docs/specs/trustworthy-machine-load-and-mesh-floor.md.
 *
 * Moves existing conversations OFF this machine when it has stayed overloaded.
 * Part C (WorkAdmission) already stops NEW work arriving here; this handles the
 * work that was already here when the overload began.
 *
 *   D1  It is a PROPOSER only. It hands the OwnershipReconciler a transient
 *       `overloadMoves()` list (topic → target, episode id, expiry). The
 *       reconciler processes it after pins, at lower precedence, through the
 *       owner-side drain, which closes the session and hands over custody. Nothing is written to the pin store.
 *       The target is chosen by RebalancePlanner + PlacementExecutor.decide.
 *   D2  A source is THIS machine once its admission has stayed closed for
 *       `sourceAfterMs` (3 min) AND it is short of session slots (`sourceSessionRatio`).
 *       Candidates are topics with a running session that has sat quiet
 *       (QuietTopicScanner). A target must have live direct evidence under
 *       2 min, verdict `ok`, not be refusing work, and have headroom after the
 *       capacity this machine has already reserved on it. Only Telegram topics
 *       are moved in this version: the shared Telegram chat is served by every
 *       machine, while a Slack conversation's workspace scope is not on the
 *       ownership record (it stays where it is). Topics with a live autonomous
 *       run are never proposed (moving one needs the operator's consent).
 *   D3  At most one live move at a time from this machine, a breaker of
 *       `maxMovesPerHour` (2), the same topic is not moved again for
 *       `recentShedMs` (30 min), and a machine seen refusing work in the last
 *       `recentShedMs` is never a target. Every move rides the SelfActionGovernor
 *       class `overload-shed` (observe-only first) and is audited to
 *       logs/overload-shed.jsonl.
 *   D4  Each proposed move takes a durable capacity reservation on its target
 *       (TTL `reservationTtlMs`), released when the target owns the topic, when
 *       the entry expires, or on TTL. The reconciler drives an in-flight transfer
 *       to claim or abort independently of this list, so a move outlives it.
 *
 * Posture: dev-gated, and dry-run first. Below pool stage `rebalance`, without a fresh
 * rebalance proof, or in dry-run, it audits each move it WOULD make and proposes
 * nothing (docs/specs/session-pool-rebalancing-finish.md).
 *
 * Honest limit: reservations are local to this machine, so two overloaded
 * machines could pick the same target in the same window. The headroom margin
 * (≥2 free sessions) and the one-move-at-a-time rule bound that to one extra
 * session per source.
 */

import fs from 'node:fs';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import path from 'node:path';

import { planRebalance, sessionRatio, type RebalanceSession } from './RebalancePlanner.js';
import { isRefusingWork, type PlacementExecutor } from './PlacementExecutor.js';
import type { MachineCapacity } from './types.js';
import { governor, consumeAdmissionToken } from '../monitoring/selfaction/governor.js';
import type { DerivedTarget } from '../monitoring/selfaction/types.js';

export interface OverloadShedConfig {
  enabled: boolean;
  dryRun: boolean;
  sourceAfterMs: number;
  maxMovesPerHour: number;
  recentShedMs: number;
  /** A topic that arrived here, or moved, is left alone this long. Follows the topic across machines. */
  topicCooldownMs: number;
  /** A machine sheds only at or above this session ratio: short of slots, not just a CPU spike. */
  sourceSessionRatio: number;
  reservationTtlMs: number;
  entryTtlMs: number;
  minTargetHeadroom: number;
  targetEvidenceMaxAgeMs: number;
}

/** Evidence-log pace for a held move; the audit log keeps its one row per episode. */
const WOULD_MOVE_AUDIT_EVERY_MS = 5 * 60_000;

export const DEFAULT_OVERLOAD_SHED: Omit<OverloadShedConfig, 'enabled'> = {
  dryRun: true,
  sourceAfterMs: 3 * 60_000,
  maxMovesPerHour: 2,
  recentShedMs: 30 * 60_000,
  topicCooldownMs: 6 * 60 * 60_000,
  sourceSessionRatio: 0.85,
  reservationTtlMs: 10 * 60_000,
  entryTtlMs: 10 * 60_000,
  minTargetHeadroom: 2,
  targetEvidenceMaxAgeMs: 2 * 60_000,
};

export interface OverloadShedDeps {
  config: () => OverloadShedConfig;
  selfMachineId: () => string | null | undefined;
  /** This machine's admission advert (null when admission is dark). */
  admission: () => { acceptingWork: boolean; enforced: boolean } | null;
  capacities: () => MachineCapacity[];
  /**
   * Active topics owned by THIS machine, with whether each is pinned. `lastMovedAt` is
   * the replicated record timestamp, so the cooldown survives a move between machines.
   */
  ownedTopics: () => Array<{ sessionKey: string; pinned: boolean; lastMovedAt?: number }>;
  /** The pool's live stage. Absent ⇒ no live move. */
  poolStage?: () => string;
  /** Does this machine hold a fresh rebalance proof? Absent ⇒ no live move. */
  proofFresh?: () => boolean;
  /**
   * Topics with a running session that has sat quiet (filled by the async scanner).
   * Only these are candidates. Absent ⇒ none: moving a topic with no running session
   * relieves nothing, and moving a working one disturbs it.
   */
  quietTopics?: () => ReadonlySet<string>;
  /** False while the reconciler itself is in dry-run, when no move could be carried out. */
  moveActuatorLive?: () => boolean;
  /** Topics reserved for the rebalance proof: never shed by the normal path. */
  isProofTopic?: (sessionKey: string) => boolean;
  /** Current owner of a topic (undefined when unknown). */
  ownerOf: (sessionKey: string) => string | undefined;
  placement: PlacementExecutor;
  hasLiveAutonomousRun?: (sessionKey: string) => boolean;
  /** Ownership status of a topic (to see a move in flight, aborted, or landed). */
  statusOf?: (sessionKey: string) => { status: string; transferTo?: string } | undefined;
  /** A topic mid-processing is never proposed (the reconciler would only defer it). */
  isTopicBusy?: (sessionKey: string) => boolean;
  /** Durable reservations + breaker state. */
  statePath?: string;
  auditPath?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/** The working-set kick for a landed move: the same one POST /pool/transfer uses, owned by the server. */
let moveAftercare: ((target: string, topic: number | string) => void) | null = null;
export function setMoveAftercare(fn: ((target: string, topic: number | string) => void) | null): void { moveAftercare = fn; }
export function getMoveAftercare(): ((target: string, topic: number | string) => void) | null { return moveAftercare; }

export interface OverloadMove {
  sessionKey: string;
  target: string;
  episodeId: string;
}

interface Reservation { sessionKey: string; target: string; expiresAt: number }
interface LiveEntry extends OverloadMove {
  expiresAt: number;
  proposedAt: number;
  /** Set once the reconciler's transfer was seen in flight toward the target. */
  sawTransferring?: boolean;
  /** A rebalance-proof move: stamps no shed state and stays out of the measures. */
  proof?: boolean;
}

/** What the drain reported for a move, in the runner's own terms. */
export interface MoveOutcome {
  status: string;
  claimLanded?: boolean;
  durationMs?: number;
  detail?: string;
}
interface PersistedState {
  reservations: Reservation[];
  moveTimes: number[];
  topicLastShed: Record<string, number>;
  lastRefusingAt: Record<string, number>;
  entry: LiveEntry | null;
  /** The overload episode (restart-safe): continues across a gap shorter than recentShedMs. */
  episode: { startedAt: number; lastClosedAt: number } | null;
  /** Moves proposed per topic in the current episode (cap: MAX_ATTEMPTS_PER_TOPIC). */
  topicAttempts: Record<string, number>;
  /** Expired-without-starting refunds per topic in the current episode (cap: MAX_REFUNDS_PER_TOPIC). */
  topicRefunds: Record<string, number>;
}

/** Bounded audit: rotate to ONE kept segment past this size. */
export const OVERLOAD_SHED_AUDIT_MAX_BYTES = 2 * 1024 * 1024;
const HOUR_MS = 60 * 60_000;
/**
 * A topic is proposed at most this many times per overload episode. A move the
 * target never claims expires and the topic stays here; after this many tries it
 * is left alone until the episode ends, so a sustained overload with a target that
 * never claims settles at 2 moves per topic instead of retrying forever.
 */
export const MAX_ATTEMPTS_PER_TOPIC = 2;
/** A proposal that expired without its transfer ever starting is refunded at most this often per topic per episode. */
export const MAX_REFUNDS_PER_TOPIC = 2;

/* @self-action-controller: overload-shed */
const overloadShedGov = governor.for('overload-shed');

/** Canonical target: one key per topic (a topic shed twice is the same target). */
export function deriveTargetKey(sessionKey: string): DerivedTarget {
  return { key: `overload-shed:${sessionKey}`, classId: 'overload-shed', keyIsVolatile: false };
}

function emptyState(): PersistedState {
  return { reservations: [], moveTimes: [], topicLastShed: {}, lastRefusingAt: {}, entry: null, episode: null, topicAttempts: {}, topicRefunds: {} };
}

export class OverloadShedPlanner {
  private state: PersistedState;
  private closedSince: number | null = null;
  private lastWouldMoveAudit = new Set<string>();
  private proofWaiter: ((moved: { moved: boolean; outcome: MoveOutcome }) => void) | null = null;
  private breakerAuditedAt = 0;
  private episodePersistedAt = 0;
  private lastTickAt: number | null = null;
  private readonly counters = { ticks: 0, proposed: 0, wouldMove: 0, claimed: 0, aborted: 0, expired: 0, breakerHeld: 0, governorHeld: 0, noTarget: 0 };
  private readonly now: () => number;

  constructor(private readonly d: OverloadShedDeps) {
    this.now = d.now ?? Date.now;
    this.state = this.load();
  }

  /** The transient move list the OwnershipReconciler reads each tick (D1). */
  overloadMoves(): OverloadMove[] {
    const e = this.state.entry;
    // A move whose transfer was already started is never handed out again: if it
    // was aborted (the target did not claim), the topic stays here for this try.
    if (!e || e.sawTransferring || !this.d.config().enabled || this.now() >= e.expiresAt) return [];
    // The switches hold a proposal that has not started, not only new ones: dry-run must
    // stop moves at once, not after this entry's 10 minutes run out.
    if (!e.proof && this.heldReason(this.d.config()) !== null) return [];
    return [{ sessionKey: e.sessionKey, target: e.target, episodeId: e.episodeId }];
  }

  /** One evaluation (every 15 s, after the load sample). */
  tick(): void {
    const cfg = this.d.config();
    const now = this.now();
    this.lastTickAt = now;
    this.counters.ticks += 1;
    if (!cfg.enabled) {
      // Disabled: forget the episode; a later enable starts fresh. Reservations
      // simply age out by TTL.
      this.closedSince = null;
      if (this.state.entry) { this.state.entry = null; this.settleProof(false, { status: 'shed-disabled' }); this.save(); }
      return;
    }
    const self = this.d.selfMachineId();
    if (!self) return;

    // ── Source tracking (D2): admission closed continuously for sourceAfterMs.
    const adv = safe(() => this.d.admission(), null);
    let dirty = false;
    if (adv && adv.acceptingWork === false) {
      this.closedSince ??= now;
      const ep = this.state.episode;
      if (!ep || now - ep.lastClosedAt >= cfg.recentShedMs) {
        this.state.episode = { startedAt: now, lastClosedAt: now };
        this.state.topicAttempts = {};
        this.state.topicRefunds = {};
        dirty = true;
      } else {
        // Persist the episode heartbeat at most once a minute (no write every sample under overload).
        ep.lastClosedAt = now;
        if (now - this.episodePersistedAt >= 60_000) dirty = true;
      }
    } else {
      this.closedSince = null;
    }

    const caps = safe(() => this.d.capacities(), [] as MachineCapacity[]);
    // Peers seen refusing work are not targets for recentShedMs (D3).
    for (const m of caps) {
      if (m.machineId !== self && isRefusingWork(m)) { this.state.lastRefusingAt[m.machineId] = now; dirty = true; }
    }

    // ── Reservation + entry upkeep (D4).
    const before = this.state.reservations.length;
    this.state.reservations = this.state.reservations.filter((r) => {
      // The live move's reservation is released by the entry upkeep below (claim,
      // abort, expiry), never by TTL while its transfer may still land.
      if (this.state.entry?.sessionKey === r.sessionKey) return true;
      if (now >= r.expiresAt) return false;
      return safe(() => this.d.ownerOf(r.sessionKey), undefined) !== r.target;
    });
    if (this.state.reservations.length !== before) dirty = true;
    this.state.moveTimes = this.state.moveTimes.filter((t) => now - t < HOUR_MS);
    for (const [k, t] of Object.entries(this.state.topicLastShed)) if (now - t >= cfg.recentShedMs) { delete this.state.topicLastShed[k]; dirty = true; }
    for (const [k, t] of Object.entries(this.state.lastRefusingAt)) if (now - t >= cfg.recentShedMs) { delete this.state.lastRefusingAt[k]; dirty = true; }

    const e = this.state.entry;
    if (e) {
      const st = this.d.statusOf ? safe(() => this.d.statusOf!(e.sessionKey), undefined) : undefined;
      const inFlight = st?.status === 'transferring' && st.transferTo === e.target;
      if (inFlight && !e.sawTransferring) { e.sawTransferring = true; dirty = true; }
      if (safe(() => this.d.ownerOf(e.sessionKey), undefined) === e.target) {
        this.counters.claimed += 1;
        this.audit({ event: 'claimed', sessionKey: e.sessionKey, target: e.target, episodeId: e.episodeId, ...(e.proof ? { proof: true } : {}) });
        featureEvidence.record('monitoring.overloadShed', { kind: 'fired', reason: 'move-claimed', context: { topic: e.sessionKey, target: e.target, episodeId: e.episodeId, dryRun: cfg.dryRun } });
        this.settleProof(true, { status: 'claimed' });
        this.state.reservations = this.state.reservations.filter((r) => r.sessionKey !== e.sessionKey);
        this.state.entry = null;
        dirty = true;
      } else if (e.sawTransferring && !inFlight) {
        // The transfer started and was aborted back (the target did not claim in time).
        this.counters.aborted += 1;
        this.audit({ event: 'aborted', sessionKey: e.sessionKey, target: e.target, episodeId: e.episodeId, ...(e.proof ? { proof: true } : {}) });
        featureEvidence.record('monitoring.overloadShed', { kind: 'error', reason: 'move-aborted', context: { topic: e.sessionKey, target: e.target, episodeId: e.episodeId, dryRun: cfg.dryRun } });
        this.settleProof(false, { status: 'aborted' });
        this.state.reservations = this.state.reservations.filter((r) => r.sessionKey !== e.sessionKey);
        this.state.entry = null;
        dirty = true;
      } else if (now >= e.expiresAt && !inFlight) {
        // Expired without the transfer ever starting (e.g. the reconciler kept deferring):
        // refund the try and the hourly slot, so a move that never happened does not
        // use up the budget.
        this.counters.expired += 1;
        // Refunds need the status view (to know the transfer never started) and are
        // themselves capped per topic per episode, so a reconciler that never acts
        // (dry-run, disabled) cannot make the planner propose forever.
        const refunds = this.state.topicRefunds[e.sessionKey] ?? 0;
        const refund = !!this.d.statusOf && !e.sawTransferring && refunds < MAX_REFUNDS_PER_TOPIC;
        if (refund) {
          this.state.topicRefunds[e.sessionKey] = refunds + 1;
          const n = (this.state.topicAttempts[e.sessionKey] ?? 1) - 1;
          if (n > 0) this.state.topicAttempts[e.sessionKey] = n; else delete this.state.topicAttempts[e.sessionKey];
          const i = this.state.moveTimes.indexOf(e.proposedAt);
          if (i >= 0) this.state.moveTimes.splice(i, 1);
        }
        this.audit({ event: 'expired', sessionKey: e.sessionKey, target: e.target, episodeId: e.episodeId, refunded: refund, ...(e.proof ? { proof: true } : {}) });
        featureEvidence.record('monitoring.overloadShed', { kind: 'error', reason: 'move-expired-unstarted', context: { topic: e.sessionKey, target: e.target, episodeId: e.episodeId, refunded: refund, dryRun: cfg.dryRun } });
        this.settleProof(false, { status: 'expired' });
        this.state.reservations = this.state.reservations.filter((r) => r.sessionKey !== e.sessionKey);
        this.state.entry = null;
        dirty = true;
      } else {
        // One live move at a time from this machine (held while its transfer is in flight).
        if (dirty) this.save();
        return;
      }
    }

    const isSource = this.isSourceNow(cfg, now, caps, self);
    if (!isSource) { if (dirty) this.save(); return; }

    // ── Breaker (D3), checked before proposing.
    if (this.state.moveTimes.length >= cfg.maxMovesPerHour) {
      this.counters.breakerHeld += 1;
      featureEvidence.recordAtMostEvery('monitoring.overloadShed', 'breaker-held', 3_600_000, { kind: 'held', reason: 'breaker-max-moves-per-hour', context: { movesLastHour: this.state.moveTimes.length, maxMovesPerHour: cfg.maxMovesPerHour, dryRun: cfg.dryRun } });
      if (now - this.breakerAuditedAt >= HOUR_MS) {
        this.breakerAuditedAt = now;
        this.audit({ event: 'breaker-held', movesLastHour: this.state.moveTimes.length });
      }
      if (dirty) this.save();
      return;
    }

    const targetEligible = (m: MachineCapacity): boolean => this.isEligibleTarget(m, cfg, self);

    const topics = safe(() => this.d.ownedTopics(), [] as Array<{ sessionKey: string; pinned: boolean; lastMovedAt?: number }>);
    const quiet = safe(() => this.d.quietTopics?.() ?? new Set<string>(), new Set<string>() as ReadonlySet<string>);
    const sessions: RebalanceSession[] = [];
    for (const t of topics) {
      if (t.pinned || !/^[1-9]\d*$/.test(t.sessionKey)) continue; // Telegram topics only
      if (!quiet.has(t.sessionKey)) continue; // no running quiet session: nothing to relieve
      if (this.d.isProofTopic && safe(() => this.d.isProofTopic!(t.sessionKey), true)) continue;
      if ((this.state.topicAttempts[t.sessionKey] ?? 0) >= MAX_ATTEMPTS_PER_TOPIC) continue;
      if (this.d.hasLiveAutonomousRun && safe(() => this.d.hasLiveAutonomousRun!(t.sessionKey), true)) continue;
      if (this.d.isTopicBusy && safe(() => this.d.isTopicBusy!(t.sessionKey), true)) continue;
      sessions.push({ sessionKey: t.sessionKey, ownerMachineId: self, lastTransferredAt: Math.max(t.lastMovedAt ?? 0, this.state.topicLastShed[t.sessionKey] ?? 0) });
    }
    // The source row is THIS machine; make sure the planner sees it as online.
    const machines = caps.map((m) => (m.machineId === self ? { ...m, online: true } : m));
    const moves = sessions.length === 0 ? [] : planRebalance({
      machines,
      sessions,
      rebalanceThresholdPercent: 1,
      placementCooldownMs: cfg.topicCooldownMs,
      now,
      maxMovesPerCycle: 1,
      isSource: (m) => m.machineId === self,
      targetEligible,
    }, this.d.placement);
    const mv = moves[0];
    if (!mv) {
      this.counters.noTarget += 1;
      featureEvidence.recordAtMostEvery('monitoring.overloadShed', 'no-target', 3_600_000, { kind: 'held', reason: sessions.length === 0 ? 'no-movable-topic' : 'no-eligible-target', context: { movableTopics: sessions.length, ownedTopics: topics.length, machines: caps.length, dryRun: cfg.dryRun } });
      if (dirty) this.save();
      return;
    }

    const episodeId = `${self}:${this.state.episode?.startedAt ?? this.closedSince}`;
    // The stage is the gate (session-pool-rebalancing-finish). Admission enforcement no
    // longer is: the source already needs real slot pressure, and tying moves to
    // enforcement would hold them behind that feature's own open flapping question.
    const held = this.heldReason(cfg);
    if (held) {
      this.counters.wouldMove += 1;
      featureEvidence.recordAtMostEvery('monitoring.overloadShed', `would-move:${mv.sessionKey}>${mv.toMachine}`, WOULD_MOVE_AUDIT_EVERY_MS, { kind: 'fired', reason: `would-move-${held}`, context: { topic: mv.sessionKey, target: mv.toMachine, episodeId, dryRun: cfg.dryRun, movableTopics: sessions.length } });
      const k = `${episodeId}|${mv.sessionKey}`;
      if (!this.lastWouldMoveAudit.has(k)) {
        if (this.lastWouldMoveAudit.size >= 1000) this.lastWouldMoveAudit.clear();
        this.lastWouldMoveAudit.add(k);
        this.audit({ event: 'would-move', sessionKey: mv.sessionKey, target: mv.toMachine, episodeId, reason: held, workState: 'idle', ...this.capacitySnapshot(caps, self, mv.toMachine) });
      }
      if (dirty) this.save();
      return;
    }

    const target = deriveTargetKey(mv.sessionKey);
    const adm = overloadShedGov.admitSync(target, { incarnation: episodeId, lane: 'job' });
    const sink = adm.outcome === 'allow' ? consumeAdmissionToken(adm.token, 'overload-shed', { targetKey: target.key }) : null;
    if (adm.outcome !== 'allow' || !sink?.proceed) {
      this.counters.governorHeld += 1;
      featureEvidence.recordAtMostEvery('monitoring.overloadShed', 'governor-held', 3_600_000, { kind: 'held', reason: `governor-${adm.outcome}`, context: { topic: mv.sessionKey, target: mv.toMachine, episodeId, outcome: adm.outcome } });
      this.audit({ event: 'governor-held', sessionKey: mv.sessionKey, target: mv.toMachine, episodeId, outcome: adm.outcome });
      if (dirty) this.save();
      return;
    }

    this.state.reservations.push({ sessionKey: mv.sessionKey, target: mv.toMachine, expiresAt: now + cfg.reservationTtlMs });
    this.state.moveTimes.push(now);
    this.state.topicLastShed[mv.sessionKey] = now;
    this.state.topicAttempts[mv.sessionKey] = (this.state.topicAttempts[mv.sessionKey] ?? 0) + 1;
    this.state.entry = { sessionKey: mv.sessionKey, target: mv.toMachine, episodeId, proposedAt: now, expiresAt: now + cfg.entryTtlMs };
    this.counters.proposed += 1;
    this.audit({ event: 'proposed', sessionKey: mv.sessionKey, target: mv.toMachine, episodeId });
    featureEvidence.record('monitoring.overloadShed', { kind: 'fired', reason: 'move-proposed', context: { topic: mv.sessionKey, target: mv.toMachine, episodeId, movesLastHour: this.state.moveTimes.length, dryRun: cfg.dryRun } });
    this.d.log?.(`overload-shed: proposing to move topic ${mv.sessionKey} to ${mv.toMachine} (this machine has been overloaded since ${new Date(this.closedSince!).toISOString()})`);
    this.save();
  }

  /**
   * One move for the rebalance proof: the same target choice and the same path out
   * (overloadMoves → reconciler → drain), with the source trigger, stage gate, dry-run
   * and cooldown exempted and the target restricted to `to`. Stamps no shed state.
   * Resolves with the move's outcome, or `refused` when it never started.
   */
  proofMove(sessionKey: string, to: string): { refused: string } | { outcome: Promise<{ moved: boolean; outcome: MoveOutcome }> } {
    const cfg = this.d.config();
    const self = this.d.selfMachineId();
    if (!cfg.enabled || !self) return { refused: 'shed-not-enabled' };
    if (this.state.entry || this.proofWaiter) return { refused: 'move-in-flight' };
    if (!safe(() => this.d.moveActuatorLive?.() ?? true, false)) return { refused: 'reconciler-dry-run' };
    const now = this.now();
    const caps = safe(() => this.d.capacities(), [] as MachineCapacity[]);
    const machines = caps.map((m) => (m.machineId === self ? { ...m, online: true } : m));
    const moves = planRebalance({
      machines,
      sessions: [{ sessionKey: sessionKey, ownerMachineId: self }],
      rebalanceThresholdPercent: 1,
      placementCooldownMs: 0,
      now,
      maxMovesPerCycle: 1,
      isSource: (m) => m.machineId === self,
      targetEligible: (m) => m.machineId === to && this.isEligibleTarget(m, cfg, self),
    }, this.d.placement);
    const mv = moves[0];
    if (!mv) return { refused: 'target-ineligible' };
    this.state.entry = { sessionKey, target: mv.toMachine, episodeId: `proof:${self}:${now}`, proposedAt: now, expiresAt: now + cfg.entryTtlMs, proof: true };
    this.audit({ event: 'proposed', sessionKey, target: mv.toMachine, episodeId: this.state.entry.episodeId, proof: true });
    this.save();
    return { outcome: new Promise((resolve) => { this.proofWaiter = resolve; }) };
  }

  /** The drain's result, reported straight back instead of inferred from ownership. */
  noteMoveOutcome(sessionKey: string, outcome: MoveOutcome): void {
    const e = this.state.entry;
    if (!e || e.sessionKey !== sessionKey) return;
    const moved = outcome.status === 'drained' || outcome.status === 'drained-interrupted';
    const caps = safe(() => this.d.capacities(), [] as MachineCapacity[]);
    this.audit({
      event: 'move-outcome', sessionKey, target: e.target, episodeId: e.episodeId, ...outcome,
      ...(e.proof ? { proof: true } : {}), ...this.capacitySnapshot(caps, this.d.selfMachineId() ?? '', e.target),
    });
    if (moved) this.counters.claimed += 1;
    else {
      this.counters.aborted += 1;
      // A move that did not happen frees its hourly slot; the try is still spent, so a
      // topic that keeps refusing settles at MAX_ATTEMPTS_PER_TOPIC.
      const i = this.state.moveTimes.indexOf(e.proposedAt);
      if (i >= 0) this.state.moveTimes.splice(i, 1);
      delete this.state.topicLastShed[sessionKey]; // it never moved, so no cooldown starts
    }
    this.state.reservations = this.state.reservations.filter((r) => r.sessionKey !== sessionKey);
    this.state.entry = null;
    this.settleProof(moved, outcome);
    this.save();
  }

  private heldReason(cfg: OverloadShedConfig): string | null {
    if (safe(() => this.d.poolStage?.(), undefined) !== 'rebalance') return 'stage-not-rebalance';
    if (!safe(() => this.d.proofFresh?.() === true, false)) return 'proof-not-fresh';
    if (cfg.dryRun) return 'dry-run';
    if (!safe(() => this.d.moveActuatorLive?.() ?? true, false)) return 'reconciler-dry-run';
    return null;
  }

  private settleProof(moved: boolean, outcome: MoveOutcome): void {
    const w = this.proofWaiter;
    this.proofWaiter = null;
    w?.({ moved, outcome });
  }

  private isSourceNow(cfg: OverloadShedConfig, now: number, caps: MachineCapacity[], self: string): boolean {
    if (this.closedSince === null || now - this.closedSince < cfg.sourceAfterMs) return false;
    const row = caps.find((m) => m.machineId === self);
    return !!row && typeof row.maxSessions === 'number' && row.maxSessions > 0 && sessionRatio(row) >= cfg.sourceSessionRatio;
  }

  private isEligibleTarget(m: MachineCapacity, cfg: OverloadShedConfig, self: string): boolean {
    if (m.machineId === self) return false;
    const l = m.liveness;
    if (!l || l.state !== 'live' || l.evidenceAgeMs === null || l.evidenceAgeMs > cfg.targetEvidenceMaxAgeMs) return false;
    if (m.loadVerdict !== 'ok' || isRefusingWork(m)) return false;
    // Closed admission counts whether or not the peer enforces it: a machine that has
    // stopped accepting is the next source, not a target.
    if (m.loadReport?.acceptingWork === false) return false;
    if (this.state.lastRefusingAt[m.machineId] !== undefined) return false;
    if (typeof m.maxSessions !== 'number' || m.maxSessions <= 0 || typeof m.activeSessionCount !== 'number') return false;
    const reserved = this.state.reservations.filter((r) => r.target === m.machineId).length;
    return m.maxSessions - m.activeSessionCount - reserved >= cfg.minTargetHeadroom;
  }

  /** The numbers behind a decision, so a later read can check it against what was true then. */
  private capacitySnapshot(caps: MachineCapacity[], self: string, target: string): Record<string, unknown> {
    const row = (id: string) => caps.find((m) => m.machineId === id);
    const s = row(self); const t = row(target);
    return {
      sourceActive: s?.activeSessionCount ?? null, sourceMax: s?.maxSessions ?? null,
      targetActive: t?.activeSessionCount ?? null, targetMax: t?.maxSessions ?? null, targetVerdict: t?.loadVerdict ?? null,
    };
  }

  status(): Record<string, unknown> {
    const cfg = this.d.config();
    const now = this.now();
    return {
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      overloadedSince: this.closedSince ? new Date(this.closedSince).toISOString() : null,
      isSource: this.isSourceNow(cfg, now, safe(() => this.d.capacities(), [] as MachineCapacity[]), this.d.selfMachineId() ?? ''),
      liveMove: this.state.entry ? { sessionKey: this.state.entry.sessionKey, target: this.state.entry.target, episodeId: this.state.entry.episodeId, expiresAt: new Date(this.state.entry.expiresAt).toISOString() } : null,
      reservations: this.state.reservations.map((r) => ({ sessionKey: r.sessionKey, target: r.target, expiresAt: new Date(r.expiresAt).toISOString() })),
      movesLastHour: this.state.moveTimes.filter((t) => now - t < HOUR_MS).length,
      maxMovesPerHour: cfg.maxMovesPerHour,
      recentlyRefusingPeers: Object.keys(this.state.lastRefusingAt),
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      counters: { ...this.counters },
    };
  }

  private load(): PersistedState {
    if (!this.d.statePath) return emptyState();
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.statePath, 'utf-8')) as Partial<PersistedState>;
      return {
        reservations: Array.isArray(raw.reservations) ? raw.reservations.filter((r) => r && typeof r.sessionKey === 'string' && typeof r.target === 'string' && typeof r.expiresAt === 'number') : [],
        moveTimes: Array.isArray(raw.moveTimes) ? raw.moveTimes.filter((t) => typeof t === 'number') : [],
        topicLastShed: raw.topicLastShed && typeof raw.topicLastShed === 'object' ? raw.topicLastShed : {},
        lastRefusingAt: raw.lastRefusingAt && typeof raw.lastRefusingAt === 'object' ? raw.lastRefusingAt : {},
        // A proof entry has no waiter after a restart, so it must not run: the proof's own
        // marker records that run as red.
        entry: raw.entry && raw.entry.proof !== true && typeof raw.entry.sessionKey === 'string' && typeof raw.entry.target === 'string' && typeof raw.entry.expiresAt === 'number' ? raw.entry : null,
        episode: raw.episode && typeof raw.episode.startedAt === 'number' && typeof raw.episode.lastClosedAt === 'number' ? raw.episode : null,
        topicAttempts: raw.topicAttempts && typeof raw.topicAttempts === 'object' ? raw.topicAttempts : {},
        topicRefunds: raw.topicRefunds && typeof raw.topicRefunds === 'object' ? raw.topicRefunds : {},
      };
    } catch {
      return emptyState(); // @silent-fallback-ok — no file yet (or unreadable): start empty; the breaker and reservations rebuild, and the reconciler still drives any in-flight transfer
    }
  }

  private save(): void {
    if (!this.d.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.d.statePath), { recursive: true });
      const tmp = `${this.d.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.d.statePath);
      this.episodePersistedAt = this.now();
    } catch (err) {
      // @silent-fallback-ok (logged): state stays in memory; the next tick retries the write.
      this.d.log?.(`overload-shed: state write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private audit(row: Record<string, unknown>): void {
    if (!this.d.auditPath) return;
    try {
      fs.mkdirSync(path.dirname(this.d.auditPath), { recursive: true });
      try {
        if (fs.statSync(this.d.auditPath).size >= OVERLOAD_SHED_AUDIT_MAX_BYTES) fs.renameSync(this.d.auditPath, `${this.d.auditPath}.1`);
      } catch { /* @silent-fallback-ok: no file yet — append proceeds; the bound is best-effort */ }
      fs.appendFileSync(this.d.auditPath, JSON.stringify({ ts: new Date(this.now()).toISOString(), dryRun: this.d.config().dryRun, ...row }) + '\n');
    } catch {
      // @silent-fallback-ok: the audit is observability; a write failure never changes a decision.
    }
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; /* @silent-fallback-ok — an unreadable input yields the conservative default (no source, no target, no topics) */ }
}

// ── Process-wide handle for the read-only status route ──
let activePlanner: OverloadShedPlanner | null = null;
export function setActiveOverloadShedPlanner(p: OverloadShedPlanner | null): void { activePlanner = p; }
export function getActiveOverloadShedPlanner(): OverloadShedPlanner | null { return activePlanner; }

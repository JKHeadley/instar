/**
 * StaleOwnerReleaseEngine — U4.2 (docs/specs/u4-2-stale-owner-release.md): the
 * CMT-1786 auto-failover, built as the EVIDENCE UPGRADE to OwnershipReconciler
 * Case C. When a topic's owner machine is genuinely dead/dark, the serving-lease
 * HOLDER force-claims its topics — but only after an evidence bar in which EVERY
 * predicate is a mechanical check over authenticated state, and every ambiguity
 * fails CLOSED (a brief strand beats a split-brain).
 *
 * One actor (spec §2.7.6): this engine is invoked FROM OwnershipReconciler.tick()
 * and issues claims through the reconciler's single CAS funnel — it is Case C's
 * evidence bar, not a second takeover authority. `ownershipEpoch` is the only
 * fence; the §2.4 `topic-claim-annotation` kind is deliberately NOT ownership
 * state (it can never answer or fence ownership).
 *
 * The evidence bar (§2.2 — ALL required; fail CLOSED on any ambiguity):
 *   1. machine death: owner offline in the pool AND observer-stamped staleness
 *      ≥ deathEvidenceMs on the OBSERVER's monotonic clock (never the owner's
 *      self-reported wall clock — R-r2-5a). Never-observed-since-boot follows
 *      the bounded bootstrap rule (R-r2-2), never a silent forever-strand.
 *   2. multi-transport disproof: unreachable via the authenticated probe on
 *      EVERY advertised transport; the advert set must be owner-authenticated
 *      (PeerEndpointRecorder provenance ONLY — R-r2-5b), non-empty, fresh, and
 *      multi-transport (a single-rope advert set is automatic ambiguity).
 *   3. quorum (verbatim Case C): online × 2 > machines.
 *   4. claimant self-connectivity proof (a claimer with a broken NIC sees
 *      everyone as dead and must never claim). 2-machine git-less mesh: the
 *      claim path is DISABLED outright (detection + escalation still run).
 *   5. owner liveness disproof over a PROVABLY FRESH evidence mirror — a stale
 *      mirror classifies AMBIGUITY, never "no recent side-effects" (R-r2-3).
 *   6. fresh re-read immediately before the claim (the caller's CAS funnel
 *      re-reads; the engine re-checks the record at claim time).
 *
 * Bounded blast radius (§2.5): maxClaimsPerTick; per-topic claim budget +
 * widening backoff carried on the REPLICATED topic-claim-annotation kind
 * (R-r2-4 — the claimer role moves with the lease, the budget must follow the
 * topic); probe verdicts single-flight + TTL-memoized + backoff + a P19 breaker
 * that degrades to ONE attention item. A declined demote (operator "no") rides
 * the same replicated kind and blocks the episode's claims on ANY claimer.
 *
 * Honesty surfaces (§2.6): every stale-detect, probe verdict, would-claim
 * (dry-run), claim and REFUSAL lands in the decision trace (state-change-gated
 * per episode, never per-tick); ambiguity persisting past the ceiling escalates
 * ONE per-episode deduped attention item — raisable by ANY quorum member
 * (R-r2-1), while the CLAIM stays lease-holder-only.
 *
 * Supervision: Tier 0 by explicit argument (§2.8) — deterministic fencing path;
 * LLM-free, synchronous verdicts, acquires NO spawn-cap slot (asserted by test).
 */

import type { SessionOwnershipRecord } from './SessionOwnership.js';
import type { MergedClaimAnnotation } from './TopicClaimAnnotationStore.js';

/** Config subtree: multiMachine.sessionPool.staleOwnerRelease (§5). */
export interface StaleOwnerReleaseConfig {
  enabled: boolean;
  dryRun: boolean;
  /** Death-evidence bound (ms). Default 180_000 (existing Case C bound). */
  deathEvidenceMs: number;
  /** Per-endpoint probe timeout (ms) — well below the lease transport's 30s. */
  probeTimeoutMs: number;
  /** Ambiguity escalates after ambiguityCeilingMultiple × deathEvidenceMs. */
  ambiguityCeilingMultiple: number;
  /** Hard cap on claims landed per tick (P19). */
  maxClaimsPerTick: number;
  /** Bootstrap rule (R-r2-2): never-observed-since-boot classifies EXPIRED only
   *  after bootstrapNonObservationMultiple × deathEvidenceMs of continuous
   *  non-observation since claimant boot (plus the durable-heartbeat tie-break). */
  bootstrapNonObservationMultiple: number;
  /** The owner self-fence TTL the §2.3 ordering invariant is validated against. */
  selfFenceTtlMs: number;
}

export const DEFAULT_STALE_OWNER_RELEASE_CONFIG: Omit<StaleOwnerReleaseConfig, 'enabled'> = {
  dryRun: true,
  deathEvidenceMs: 180_000,
  probeTimeoutMs: 8_000,
  ambiguityCeilingMultiple: 3,
  maxClaimsPerTick: 2,
  bootstrapNonObservationMultiple: 3,
  selfFenceTtlMs: 60_000,
};

/**
 * §2.3 TTL-ordering invariant (R-r2-3, part 1): "expired implies self-fenced by
 * construction" holds ONLY when
 *   deathEvidenceMs > selfFenceTtlMs + reconcilerTickMs + clockSkewSlackMs.
 * This is an INVARIANT of the design, not a tuning suggestion — a violating
 * combination is REJECTED at config validation (the existing multiMachine
 * reject-nonsensical-combinations-at-startup pattern). Returns null when valid,
 * else a human-readable rejection message.
 */
export function validateStaleOwnerReleaseInvariants(
  cfg: Pick<StaleOwnerReleaseConfig, 'deathEvidenceMs' | 'selfFenceTtlMs'>,
  reconcilerTickMs: number,
  clockSkewSlackMs: number,
): string | null {
  const floor = cfg.selfFenceTtlMs + reconcilerTickMs + clockSkewSlackMs;
  if (!(cfg.deathEvidenceMs > floor)) {
    return (
      `multiMachine.sessionPool.staleOwnerRelease: deathEvidenceMs (${cfg.deathEvidenceMs}ms) must be STRICTLY greater than ` +
      `selfFenceTtlMs + reconcilerTickMs + clockSkewSlackMs (${cfg.selfFenceTtlMs} + ${reconcilerTickMs} + ${clockSkewSlackMs} = ${floor}ms) — ` +
      `otherwise a stale-owner claim can land while the owner is still legitimately emitting ` +
      `("expired implies self-fenced" breaks; u4-2 spec §2.3). Raise deathEvidenceMs or lower selfFenceTtlMs.`
    );
  }
  return null;
}

/** §2.9 refusal reasons (closed enum — the FD-7 telemetry the soak is judged on). */
export type StaleOwnerRefusalReason =
  | 'transport-ambiguity'
  | 'not-expired'
  | 'quorum-fail'
  | 'self-proof-fail'
  | 'side-effect-fresh';

/** The machine-level evidence verdict for one owner in one tick. */
export type OwnerEvidenceVerdict =
  | { verdict: 'healthy' }
  | { verdict: 'expired' }
  | { verdict: 'refused'; reason: StaleOwnerRefusalReason }
  | { verdict: 'ambiguity'; reason: StaleOwnerRefusalReason };

/** One probe outcome per (owner, episode) — memoized, single-flight. */
export type ProbeVerdict = 'reachable' | 'unreachable' | 'error';

export interface AdvertSetView {
  /** Owner-authenticated endpoints (PeerEndpointRecorder provenance ONLY). */
  endpoints: Array<{ kind: string; url: string }>;
  /** Whether the advert set is freshness-bounded (wiring computes the bound). */
  fresh: boolean;
}

export interface StaleOwnerTraceEntry {
  ts: string;
  type: 'stale-detect' | 'probe-verdict' | 'would-claim' | 'claim' | 'refusal' | 'ambiguity-escalated' | 'p19-giveup' | 'declined-demote';
  owner?: string;
  episodeId?: string;
  topic?: string;
  reason?: string;
  detail?: string;
}

export interface StaleOwnerAttentionItem {
  id: string;
  title: string;
  body: string;
  priority: 'high' | 'medium';
  sourceContext: string;
}

export interface StaleOwnerReleaseDeps {
  /** Live-read feature gate (dev-gate resolved by the wiring). */
  enabled: () => boolean;
  dryRun: () => boolean;
  config: () => StaleOwnerReleaseConfig;
  selfMachineId: () => string | null;
  /** All registered machines with OBSERVER-STAMPED liveness (R-r2-5a: the wiring
   *  MUST feed routerReceivedAt-derived values, never selfReportedLastSeen). */
  machines: () => Array<{ machineId: string; online: boolean; observerLastSeenMs: number }>;
  /** Whether THIS machine holds the serving lease (the sole-claimer arbiter). */
  holdsLease: () => boolean;
  /** All known ownership records (the registry `all()` scan). */
  listOwnershipRecords: () => SessionOwnershipRecord[];
  /**
   * Durable last-known heartbeat for a machine (the git-synced coarseHeartbeat
   * re-feed — bootstrap rule condition (b), a tie-breaker only per R-r3-3).
   * null = no durable record. Wall-clock epoch-ms.
   */
  durableLastKnownHeartbeatMs: (machineId: string) => number | null;
  /** Owner-authenticated advert set (R-r2-5b — PeerEndpointRecorder provenance
   *  ONLY; the git registry's lastKnownUrl is NOT acceptable input). */
  advertSet: (machineId: string) => AdvertSetView;
  /** Probe ONE advertised endpoint with the authenticated signed handshake.
   *  Resolves true iff an identity-verified response arrived within the timeout. */
  probeEndpoint: (machineId: string, endpoint: { kind: string; url: string }, timeoutMs: number) => Promise<boolean>;
  /** Claimant self-connectivity proof (evidence 4): a successful authenticated
   *  probe of a third peer, or (2-machine) verified reach of the durable lease
   *  authority. Resolves false on ANY uncertainty. */
  selfConnectivityProof: () => Promise<boolean>;
  /** Whether a durable third-party lease authority exists (git substrate). A
   *  2-machine mesh WITHOUT one has its claim path DISABLED (fail closed). */
  hasDurableLeaseAuthority: () => boolean;
  /** Evidence-5 mirror (§2.2.5): the claimant's replicated-channel mirror. */
  evidenceMirror: () => {
    /** Last SUCCESSFUL sync of the replicated channel (epoch-ms), or null. */
    lastSyncOkMs: number | null;
    /** Newest authenticated side-effect from `machineId` on the mirror
     *  (placement/ownership emissions + lease/ownership renewals), or null. */
    lastOwnerSideEffectMs: (machineId: string) => number | null;
  };
  /** Merged replicated topic-claim-annotations (per-topic budget / suspension /
   *  declined-demote — R-r2-4: read the REPLICATED view, never local memory). */
  claimAnnotations: () => Map<number, MergedClaimAnnotation>;
  /**
   * Issue the force-claim through the reconciler's single CAS funnel. The
   * callee re-reads the record (evidence 6) and stamps the extended nonce
   * `${self}:stale-owner-release:${sessionKey}:${episodeId}:${now}` (§2.7.5).
   * Returns true iff the CAS landed.
   */
  actForceClaim: (sessionKey: string, episodeId: string) => boolean;
  /** Emit/refresh the claim annotation (suspension + budget) — level-reconciled:
   *  a claim that landed without its annotation is re-emitted idempotently. */
  emitClaimAnnotation: (input: {
    topic: number;
    episodeId: string;
    suspended: boolean;
    claimedBy: string;
    claimCount: number;
    backoffUntilMs?: number;
    declinedDemote?: boolean;
  }) => void;
  /** Attempt the working-set pull for a claimed topic (queues durably against a
   *  provably-dark producer — §2.4; failures never block the claim). */
  pullWorkingSet: (topic: number) => void;
  /** Post-claim hook (continuation disclosure + paced resume routing). */
  onClaimed?: (topic: number, episodeId: string, prevOwner: string) => void;
  /** Append one decision-trace line (logs/stale-owner-release.jsonl). */
  trace: (entry: StaleOwnerTraceEntry) => void;
  /** Raise ONE deduped attention item (episode-keyed; P17-coalesced pool-wide). */
  raiseAttention: (item: StaleOwnerAttentionItem) => void;
  now?: () => number;
  monotonicNow?: () => number;
  logger?: (msg: string) => void;
}

interface OwnerEpisode {
  episodeId: string;
  owner: string;
  openedAtMono: number;
  openedAtWall: number;
  /** Last classified verdict (state-change gating for the trace). */
  lastVerdict: string | null;
  /** Mono time ambiguity was first observed in this episode (escalation clock). */
  ambiguitySinceMono: number | null;
  escalated: boolean;
  /** Topics already would-claim-logged this episode (log once per topic). */
  wouldClaimLogged: Set<string>;
  /** Mono time the owner was last seen healthy (episode calm-close clock). */
  healthySinceMono: number | null;
  /** Memoized probe verdict + when it was computed (mono). */
  probe: { verdict: ProbeVerdict; atMono: number } | null;
  probeInFlight: boolean;
  probeErrors: number;
  probeBreakerOpen: boolean;
  /** Widening backoff between probe attempts (mono floor). */
  nextProbeAtMono: number;
}

/** 30 min of calm closes an episode (§2.6). */
const EPISODE_CALM_CLOSE_MS = 30 * 60_000;
/** Memoized probe verdict TTL (one reachability verdict per episode window). */
const PROBE_MEMO_TTL_MS = 60_000;
/** P19: consecutive probe errors that open the probe breaker. */
const PROBE_BREAKER_ERRORS = 5;
/** Per-topic claim budget before the loud P19 give-up. */
const PER_TOPIC_CLAIM_BUDGET = 5;
/** Widening backoff base between claim attempts on the same topic. */
const CLAIM_BACKOFF_BASE_MS = 60_000;

export interface StaleOwnerReleaseStatus {
  enabled: boolean;
  dryRun: boolean;
  lastTickAt: string | null;
  counters: {
    attempts: number;
    claims: number;
    wouldClaims: number;
    refusalsByReason: Record<StaleOwnerRefusalReason, number>;
    ambiguities: number;
    escalations: number;
    p19GiveUps: number;
  };
  evidenceClasses: Record<string, number>;
  probeBreaker: { openOwners: string[] };
  lastEpisode: { episodeId: string; owner: string; verdict: string; at: string } | null;
  openEpisodes: Array<{ episodeId: string; owner: string; openedAt: string; lastVerdict: string | null; escalated: boolean }>;
}

export class StaleOwnerReleaseEngine {
  private readonly d: StaleOwnerReleaseDeps;
  private readonly episodes = new Map<string, OwnerEpisode>(); // by owner
  /** Observer-clock liveness: mono-ms an owner's observer-stamped lastSeen last
   *  ADVANCED (the FencedLease-F2 verified fold-in pattern). Absent = never
   *  observed since claimant boot (the R-r2-2 bootstrap case). */
  private readonly lastSeenMono = new Map<string, number>();
  private readonly lastSeenWallReading = new Map<string, number>();
  private readonly bootMono: number;
  private lastTickAtWall = 0;
  private lastEpisodeSummary: StaleOwnerReleaseStatus['lastEpisode'] = null;
  private readonly counters = {
    attempts: 0,
    claims: 0,
    wouldClaims: 0,
    refusalsByReason: {
      'transport-ambiguity': 0,
      'not-expired': 0,
      'quorum-fail': 0,
      'self-proof-fail': 0,
      'side-effect-fresh': 0,
    } as Record<StaleOwnerRefusalReason, number>,
    ambiguities: 0,
    escalations: 0,
    p19GiveUps: 0,
  };
  private readonly evidenceClasses: Record<string, number> = {};

  constructor(deps: StaleOwnerReleaseDeps) {
    this.d = deps;
    this.bootMono = this.mono();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private mono(): number {
    if (this.d.monotonicNow) return this.d.monotonicNow();
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
  private log(m: string): void {
    try { this.d.logger?.(`[StaleOwnerRelease] ${m}`); } catch { /* @silent-fallback-ok — a logger fault must never gate an evidence verdict (observability only) */ }
  }
  private trace(entry: Omit<StaleOwnerTraceEntry, 'ts'>): void {
    try { this.d.trace({ ts: new Date(this.now()).toISOString(), ...entry }); } catch { /* @silent-fallback-ok — the decision trace is observability; a trace-write fault must never gate or flip a verdict */ }
  }
  private bumpEvidenceClass(cls: string): void {
    this.evidenceClasses[cls] = (this.evidenceClasses[cls] ?? 0) + 1;
  }

  isActive(): boolean {
    try { return this.d.enabled(); } catch { return false; /* @silent-fallback-ok — an unreadable feature gate reads as INACTIVE (fail dark, the safe direction) */ }
  }

  /**
   * One evidence pass (invoked from OwnershipReconciler.tick()). Deterministic
   * over injected state; probes are kicked off asynchronously and their
   * verdicts consumed on LATER ticks (single-flight, memoized) — the tick
   * itself never blocks on the network.
   */
  tick(): void {
    if (!this.isActive()) return;
    const self = this.d.selfMachineId();
    if (!self) return;
    const machines = this.d.machines();
    if (machines.length < 2) return; // single-machine strict no-op
    const cfg = this.d.config();
    const nowWall = this.now();
    const nowMono = this.mono();
    this.lastTickAtWall = nowWall;

    // ── Fold observer-stamped liveness into the monotonic map (F2 pattern):
    // stamp mono time whenever a machine's observer lastSeen ADVANCES.
    const byId = new Map<string, { machineId: string; online: boolean; observerLastSeenMs: number }>();
    for (const m of machines) {
      byId.set(m.machineId, m);
      const prev = this.lastSeenWallReading.get(m.machineId);
      if (m.observerLastSeenMs > 0 && (prev === undefined || m.observerLastSeenMs > prev)) {
        this.lastSeenWallReading.set(m.machineId, m.observerLastSeenMs);
        this.lastSeenMono.set(m.machineId, nowMono);
      }
    }

    // ── Candidate owners: peers that own at least one live topic record.
    const records = this.d.listOwnershipRecords().filter(
      (r) => r.status !== 'released' && r.ownerMachineId && r.ownerMachineId !== self,
    );
    const topicsByOwner = new Map<string, SessionOwnershipRecord[]>();
    for (const r of records) {
      const list = topicsByOwner.get(r.ownerMachineId) ?? [];
      list.push(r);
      topicsByOwner.set(r.ownerMachineId, list);
    }

    const holdsLease = this.d.holdsLease();
    const online = machines.filter((m) => m.online).length;
    const inQuorum = online * 2 > machines.length || machines.length <= 2;
    let claimsThisTick = 0;

    for (const [owner, topics] of topicsByOwner) {
      const view = byId.get(owner);
      const ownerOnline = !!view?.online;

      // Healthy owner → close-episode bookkeeping and move on.
      if (ownerOnline) {
        const ep = this.episodes.get(owner);
        if (ep) {
          if (ep.healthySinceMono === null) ep.healthySinceMono = nowMono;
          if (nowMono - ep.healthySinceMono >= EPISODE_CALM_CLOSE_MS) {
            this.episodes.delete(owner); // calm window elapsed → episode closed
          }
        }
        continue;
      }

      // Owner offline → open (or continue) the episode.
      const ep = this.openEpisode(owner, nowMono, nowWall);
      ep.healthySinceMono = null;

      const verdict = this.classifyOwner(owner, view, ep, cfg, nowWall, nowMono, machines.length, inQuorum);
      this.recordVerdict(ep, owner, verdict, cfg, nowMono, nowWall);

      if (verdict.verdict !== 'expired') continue;

      // ── Claims: lease-holder-only (§2.1 arbiter). Detection + escalation ran
      // above regardless of the lease (R-r2-1 quorum-member hosting).
      if (!holdsLease) {
        this.trace({ type: 'refusal', owner, episodeId: ep.episodeId, reason: 'not-lease-holder', detail: 'claims are lease-holder-only; detection continues' });
        continue;
      }

      const annotations = this.d.claimAnnotations();
      for (const rec of topics) {
        if (claimsThisTick >= cfg.maxClaimsPerTick) break; // P19 per-tick cap

        // FSM respect (§2.1): a fresh drain-flow transferring record is held
        // back — a mid-drain death rides the existing transferring-timeout
        // recovery, never a raw CAS over it.
        if (rec.status === 'transferring' && rec.drainInFlight === true && nowWall - (rec.timestamp ?? 0) < 45_000) {
          continue;
        }

        const topicNum = Number(rec.sessionKey);
        const ann = Number.isFinite(topicNum) ? annotations.get(topicNum) : undefined;

        // Declined demote (§2.6): the operator's "no" durably pins the topic
        // against claim for this episode — on ANY claimer (replicated read).
        if (ann?.declinedDemote && ann.episodeId === ep.episodeId) {
          this.trace({ type: 'refusal', owner, episodeId: ep.episodeId, topic: rec.sessionKey, reason: 'declined-demote' });
          continue;
        }

        // Per-topic replicated claim budget + widening backoff (R-r2-4).
        const claimCount = ann?.claimCount ?? 0;
        if (claimCount >= PER_TOPIC_CLAIM_BUDGET) {
          this.p19GiveUp(owner, ep, rec.sessionKey, `per-topic claim budget exhausted (${claimCount})`);
          continue;
        }
        if (typeof ann?.backoffUntilMs === 'number' && nowWall < ann.backoffUntilMs) {
          continue; // inside the widening backoff window
        }

        this.counters.attempts++;

        if (this.d.dryRun()) {
          // State-change-gated would-claim: once per topic per episode (§2.6).
          if (!ep.wouldClaimLogged.has(rec.sessionKey)) {
            ep.wouldClaimLogged.add(rec.sessionKey);
            this.counters.wouldClaims++;
            this.trace({ type: 'would-claim', owner, episodeId: ep.episodeId, topic: rec.sessionKey });
            this.lastEpisodeSummary = { episodeId: ep.episodeId, owner, verdict: 'would-claim', at: new Date(nowWall).toISOString() };
          }
          continue;
        }

        // Evidence 6: fresh re-read immediately before the claim.
        const fresh = this.d.listOwnershipRecords().find((r) => r.sessionKey === rec.sessionKey);
        if (!fresh || fresh.status === 'released' || fresh.ownerMachineId !== owner) {
          continue; // the world moved — re-evaluate next tick
        }

        const landed = this.d.actForceClaim(rec.sessionKey, ep.episodeId);
        const nextCount = claimCount + 1;
        const backoffUntilMs = nowWall + CLAIM_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, nextCount - 1));
        if (landed) {
          claimsThisTick++;
          this.counters.claims++;
          this.trace({ type: 'claim', owner, episodeId: ep.episodeId, topic: rec.sessionKey });
          this.lastEpisodeSummary = { episodeId: ep.episodeId, owner, verdict: 'claimed', at: new Date(nowWall).toISOString() };
          if (Number.isFinite(topicNum)) {
            // §2.4/§2.7.4: the claim CAS and the suspension annotation are
            // emitted in this single apply path, keyed to the same episode id.
            // Level-reconciled: re-emitted idempotently if it didn't land.
            try {
              this.d.emitClaimAnnotation({
                topic: topicNum,
                episodeId: ep.episodeId,
                suspended: true,
                claimedBy: this.d.selfMachineId() ?? '',
                claimCount: nextCount,
                backoffUntilMs,
              });
            } catch { /* annotation is level-reconciled next tick */ }
            try { this.d.pullWorkingSet(topicNum); } catch { /* queued durably by the carrier */ }
            try { this.d.onClaimed?.(topicNum, ep.episodeId, owner); } catch { /* disclosure is best-effort */ }
          }
        } else if (Number.isFinite(topicNum)) {
          // A refused CAS still consumes budget (the flap-bounding purpose).
          try {
            this.d.emitClaimAnnotation({
              topic: topicNum,
              episodeId: ep.episodeId,
              suspended: false,
              claimedBy: this.d.selfMachineId() ?? '',
              claimCount: nextCount,
              backoffUntilMs,
            });
          } catch { /* level-reconciled */ }
        }
      }
    }

    // Prune episodes for owners that no longer own any live topic.
    for (const owner of [...this.episodes.keys()]) {
      if (!topicsByOwner.has(owner)) this.episodes.delete(owner);
    }
  }

  /** Record the operator's durable "no" for an owner's current episode (§2.6). */
  recordDeclinedDemote(topic: number, episodeId: string): void {
    const ann = this.d.claimAnnotations().get(topic);
    this.d.emitClaimAnnotation({
      topic,
      episodeId,
      suspended: ann?.suspended ?? false,
      claimedBy: this.d.selfMachineId() ?? '',
      claimCount: ann?.claimCount ?? 0,
      declinedDemote: true,
    });
    this.trace({ type: 'declined-demote', topic: String(topic), episodeId });
  }

  private openEpisode(owner: string, nowMono: number, nowWall: number): OwnerEpisode {
    let ep = this.episodes.get(owner);
    if (!ep) {
      ep = {
        episodeId: `${owner}-${nowWall}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64),
        owner,
        openedAtMono: nowMono,
        openedAtWall: nowWall,
        lastVerdict: null,
        ambiguitySinceMono: null,
        escalated: false,
        wouldClaimLogged: new Set(),
        healthySinceMono: null,
        probe: null,
        probeInFlight: false,
        probeErrors: 0,
        probeBreakerOpen: false,
        nextProbeAtMono: 0,
      };
      this.episodes.set(owner, ep);
      this.trace({ type: 'stale-detect', owner, episodeId: ep.episodeId });
    }
    return ep;
  }

  /** The §2.2 evidence bar for ONE owner. Fail CLOSED on every uncertainty. */
  private classifyOwner(
    owner: string,
    view: { machineId: string; online: boolean; observerLastSeenMs: number } | undefined,
    ep: OwnerEpisode,
    cfg: StaleOwnerReleaseConfig,
    nowWall: number,
    nowMono: number,
    machineCount: number,
    inQuorum: boolean,
  ): OwnerEvidenceVerdict {
    // ── Evidence 1: machine death (observer monotonic clock; R-r2-5a input).
    const seenMono = this.lastSeenMono.get(owner);
    if (seenMono !== undefined) {
      if (nowMono - seenMono < cfg.deathEvidenceMs) {
        this.bumpEvidenceClass('not-expired');
        return { verdict: 'refused', reason: 'not-expired' };
      }
    } else {
      // Never observed since claimant boot — the R-r2-2 bounded bootstrap rule.
      const nonObservedMs = nowMono - this.bootMono;
      const bound = cfg.bootstrapNonObservationMultiple * cfg.deathEvidenceMs;
      const durable = this.d.durableLastKnownHeartbeatMs(owner);
      const durableOldEnough = durable === null || nowWall - durable >= cfg.deathEvidenceMs;
      if (!(nonObservedMs >= bound && durableOldEnough)) {
        this.bumpEvidenceClass('bootstrap-ambiguity');
        return { verdict: 'ambiguity', reason: 'not-expired' };
      }
      this.bumpEvidenceClass('bootstrap-expired');
    }

    // ── Evidence 3: quorum (cheap — before the network evidence).
    if (!inQuorum) {
      this.bumpEvidenceClass('quorum-fail');
      return { verdict: 'refused', reason: 'quorum-fail' };
    }

    // ── 2-machine git-less mesh: claim path DISABLED (§2.2.4 — fail closed;
    // detection and escalation still run, which is why this is 'ambiguity').
    if (machineCount === 2 && !this.d.hasDurableLeaseAuthority()) {
      this.bumpEvidenceClass('two-machine-gitless');
      return { verdict: 'ambiguity', reason: 'self-proof-fail' };
    }

    // ── Evidence 2: multi-transport disproof over an owner-authenticated,
    // fresh, multi-transport advert set (R-r2-5b provenance).
    let adverts: AdvertSetView;
    try {
      adverts = this.d.advertSet(owner);
    } catch {
      this.bumpEvidenceClass('advert-read-error');
      return { verdict: 'ambiguity', reason: 'transport-ambiguity' };
    }
    if (!adverts || adverts.endpoints.length === 0 || !adverts.fresh) {
      this.bumpEvidenceClass('advert-empty-or-stale');
      return { verdict: 'ambiguity', reason: 'transport-ambiguity' };
    }
    const kinds = new Set(adverts.endpoints.map((e) => e.kind));
    if (kinds.size < 2) {
      // Single-transport advertisement is automatic ambiguity — the single-rope
      // false-death is the exact bug to avoid (surfaced as a U4.5 rope-health
      // line, not claimed around).
      this.bumpEvidenceClass('advert-single-transport');
      return { verdict: 'ambiguity', reason: 'transport-ambiguity' };
    }

    const probe = this.probeVerdict(owner, ep, adverts, cfg, nowMono);
    if (probe === 'reachable') {
      // Alive on ≥1 transport — refresh the liveness stamp so evidence 1 stays
      // honest, and refuse.
      this.lastSeenMono.set(owner, nowMono);
      this.bumpEvidenceClass('probe-reachable');
      return { verdict: 'refused', reason: 'not-expired' };
    }
    if (probe !== 'unreachable') {
      this.bumpEvidenceClass('probe-pending-or-error');
      return { verdict: 'ambiguity', reason: 'transport-ambiguity' };
    }
    this.bumpEvidenceClass('probe-unreachable-all-transports');

    // ── Evidence 4: claimant self-connectivity proof.
    if (this.selfProofState !== 'ok') {
      this.kickSelfProof();
      if (this.selfProofState === 'failed') {
        this.bumpEvidenceClass('self-proof-fail');
        return { verdict: 'refused', reason: 'self-proof-fail' };
      }
      this.bumpEvidenceClass('self-proof-pending');
      return { verdict: 'ambiguity', reason: 'self-proof-fail' };
    }

    // ── Evidence 5: owner liveness disproof over a PROVABLY FRESH mirror.
    let mirror: ReturnType<StaleOwnerReleaseDeps['evidenceMirror']>;
    try {
      mirror = this.d.evidenceMirror();
    } catch {
      this.bumpEvidenceClass('mirror-read-error');
      return { verdict: 'ambiguity', reason: 'side-effect-fresh' };
    }
    const syncOk = mirror.lastSyncOkMs;
    if (syncOk === null || nowWall - syncOk > cfg.deathEvidenceMs) {
      // A mirror not successfully synced inside the window classifies AMBIGUITY
      // — a stale mirror must never read as "no recent side-effects" (R-r2-3).
      this.bumpEvidenceClass('mirror-stale');
      return { verdict: 'ambiguity', reason: 'side-effect-fresh' };
    }
    const lastEffect = mirror.lastOwnerSideEffectMs(owner);
    if (lastEffect !== null && nowWall - lastEffect < cfg.deathEvidenceMs) {
      this.bumpEvidenceClass('side-effect-fresh');
      return { verdict: 'refused', reason: 'side-effect-fresh' };
    }

    this.bumpEvidenceClass('expired');
    return { verdict: 'expired' };
  }

  // ── Evidence 4 (async, memoized per tick window) ──────────────────────
  private selfProofState: 'unknown' | 'pending' | 'ok' | 'failed' = 'unknown';
  private selfProofAtMono = 0;
  private kickSelfProof(): void {
    const nowMono = this.mono();
    if (this.selfProofState === 'pending') return;
    if ((this.selfProofState === 'ok' || this.selfProofState === 'failed') && nowMono - this.selfProofAtMono < PROBE_MEMO_TTL_MS) return;
    this.selfProofState = 'pending';
    void this.d
      .selfConnectivityProof()
      .then((ok) => {
        this.selfProofState = ok ? 'ok' : 'failed';
        this.selfProofAtMono = this.mono();
      })
      .catch(() => {
        this.selfProofState = 'failed';
        this.selfProofAtMono = this.mono();
      });
  }

  /**
   * ONE reachability verdict per (owner, episode) — single-flight, TTL-memoized,
   * widening backoff between attempts, P19 breaker that degrades to the
   * attention item. Returns the memoized verdict, or 'error' while pending /
   * breaker-open (which classifies as ambiguity upstream — fail closed).
   */
  private probeVerdict(owner: string, ep: OwnerEpisode, adverts: AdvertSetView, cfg: StaleOwnerReleaseConfig, nowMono: number): ProbeVerdict | 'pending' {
    if (ep.probe && nowMono - ep.probe.atMono < PROBE_MEMO_TTL_MS) return ep.probe.verdict;
    if (ep.probeBreakerOpen) return 'error';
    if (ep.probeInFlight) return 'pending';
    if (nowMono < ep.nextProbeAtMono) return ep.probe?.verdict ?? 'pending';

    ep.probeInFlight = true;
    const endpoints = adverts.endpoints.slice(0, 8); // bounded fan-out
    void Promise.all(
      endpoints.map((e) =>
        this.d
          .probeEndpoint(owner, e, cfg.probeTimeoutMs)
          .then((ok) => (ok ? 'reachable' : 'unreachable'))
          .catch(() => 'error' as const),
      ),
    )
      .then((results) => {
        ep.probeInFlight = false;
        const monoNow = this.mono();
        let verdict: ProbeVerdict;
        if (results.some((r) => r === 'reachable')) {
          verdict = 'reachable';
          ep.probeErrors = 0;
        } else if (results.every((r) => r === 'unreachable')) {
          verdict = 'unreachable';
          ep.probeErrors = 0;
        } else {
          verdict = 'error';
          ep.probeErrors++;
          if (ep.probeErrors >= PROBE_BREAKER_ERRORS) {
            ep.probeBreakerOpen = true;
            this.p19GiveUp(owner, ep, undefined, `probe breaker open after ${ep.probeErrors} consecutive errors`);
          }
        }
        ep.probe = { verdict, atMono: monoNow };
        // Widening backoff between probe episodes.
        const attempt = Math.min(6, Math.max(1, ep.probeErrors + 1));
        ep.nextProbeAtMono = monoNow + PROBE_MEMO_TTL_MS * attempt;
        this.trace({ type: 'probe-verdict', owner, episodeId: ep.episodeId, detail: `${verdict} across ${endpoints.length} transport(s)` });
      })
      .catch(() => {
        ep.probeInFlight = false;
      });
    return 'pending';
  }

  private recordVerdict(ep: OwnerEpisode, owner: string, v: OwnerEvidenceVerdict, cfg: StaleOwnerReleaseConfig, nowMono: number, nowWall: number): void {
    const label = v.verdict === 'expired' || v.verdict === 'healthy' ? v.verdict : `${v.verdict}:${v.reason}`;
    if (ep.lastVerdict !== label) {
      // State-change-gated trace (first observation / verdict change — §2.6).
      ep.lastVerdict = label;
      if (v.verdict === 'refused') {
        this.counters.refusalsByReason[v.reason]++;
        this.trace({ type: 'refusal', owner, episodeId: ep.episodeId, reason: v.reason });
      } else if (v.verdict === 'ambiguity') {
        this.counters.ambiguities++;
        this.trace({ type: 'refusal', owner, episodeId: ep.episodeId, reason: v.reason, detail: 'ambiguity (fail closed)' });
      }
      this.lastEpisodeSummary = { episodeId: ep.episodeId, owner, verdict: label, at: new Date(nowWall).toISOString() };
    }

    // Bounded ambiguity → the per-episode deduped operator escalation (§2.6),
    // hosted on ANY quorum member (R-r2-1) — this method runs on every member.
    if (v.verdict === 'ambiguity') {
      if (ep.ambiguitySinceMono === null) ep.ambiguitySinceMono = nowMono;
      const ceiling = cfg.ambiguityCeilingMultiple * cfg.deathEvidenceMs;
      if (!ep.escalated && nowMono - ep.ambiguitySinceMono >= ceiling) {
        ep.escalated = true;
        this.counters.escalations++;
        this.trace({ type: 'ambiguity-escalated', owner, episodeId: ep.episodeId });
        try {
          this.d.raiseAttention({
            id: `stale-owner:${ep.episodeId}`,
            title: `Topic(s) look stranded on ${owner} — I can't prove the owner's state`,
            body:
              `Machine ${owner} has been offline past the evidence window but the death evidence stays ambiguous ` +
              `(fail-closed). Topics it owns are not being served. Your call: demote it (I take its topics over) or wait. ` +
              `Episode ${ep.episodeId}.`,
            priority: 'high',
            sourceContext: `stale-owner-release:${owner}`,
          });
        } catch { /* @silent-fallback-ok — attention raise is best-effort; the escalation is already durably recorded in the decision trace */ }
      }
    } else {
      ep.ambiguitySinceMono = null;
    }
  }

  private p19GiveUp(owner: string, ep: OwnerEpisode, topic: string | undefined, detail: string): void {
    // Loud give-up, ONE deduped attention item (the resurrection-cap mirror).
    const key = `stale-owner-giveup:${ep.episodeId}${topic ? `:${topic}` : ''}`;
    if (this.evidenceClasses[key]) return; // once per episode(+topic)
    this.evidenceClasses[key] = 1;
    this.counters.p19GiveUps++;
    this.trace({ type: 'p19-giveup', owner, episodeId: ep.episodeId, topic, detail });
    try {
      this.d.raiseAttention({
        id: key,
        title: `Stale-owner release gave up${topic ? ` on topic ${topic}` : ''} (${owner})`,
        body: `${detail}. No further automatic attempts this episode — manual demote or investigation needed.`,
        priority: 'high',
        sourceContext: `stale-owner-release:${owner}`,
      });
    } catch { /* best-effort */ }
  }

  /** §2.9 status surface (assembled per tick, never stale on early return). */
  status(): StaleOwnerReleaseStatus {
    let enabled = false;
    let dryRun = true;
    try { enabled = this.d.enabled(); } catch { /* fail dark */ }
    try { dryRun = this.d.dryRun(); } catch { /* fail dry */ }
    return {
      enabled,
      dryRun,
      lastTickAt: this.lastTickAtWall ? new Date(this.lastTickAtWall).toISOString() : null,
      counters: {
        attempts: this.counters.attempts,
        claims: this.counters.claims,
        wouldClaims: this.counters.wouldClaims,
        refusalsByReason: { ...this.counters.refusalsByReason },
        ambiguities: this.counters.ambiguities,
        escalations: this.counters.escalations,
        p19GiveUps: this.counters.p19GiveUps,
      },
      evidenceClasses: Object.fromEntries(Object.entries(this.evidenceClasses).filter(([k]) => !k.startsWith('stale-owner-giveup:'))),
      probeBreaker: {
        openOwners: [...this.episodes.values()].filter((e) => e.probeBreakerOpen).map((e) => e.owner),
      },
      lastEpisode: this.lastEpisodeSummary,
      openEpisodes: [...this.episodes.values()].map((e) => ({
        episodeId: e.episodeId,
        owner: e.owner,
        openedAt: new Date(e.openedAtWall).toISOString(),
        lastVerdict: e.lastVerdict,
        escalated: e.escalated,
      })),
    };
  }
}

/**
 * §2.9 `ownershipLeaseState` derivation for /pool/placement (R-r2 minor) —
 * DERIVED from record status + evidence state, per the spec's table.
 */
export type OwnershipLeaseState = 'held' | 'stale' | 'releasing' | 'claimed';

export function deriveOwnershipLeaseState(
  record: Pick<SessionOwnershipRecord, 'status' | 'nonce'> | null,
  opts: { evidenceEpisodeOpen: boolean; suspensionAnnotationPresent: boolean },
): OwnershipLeaseState | null {
  if (!record || record.status === 'released') return null;
  if (record.status === 'transferring') return 'releasing';
  // A stale-owner-release force-claim stamps `stale-owner-release` into the
  // extended nonce grammar (§2.7.5) — visible here and in the reap-log.
  const viaStaleOwnerClaim = typeof record.nonce === 'string' && record.nonce.includes(':stale-owner-release:');
  if (record.status === 'active' && viaStaleOwnerClaim && opts.suspensionAnnotationPresent) return 'claimed';
  if (opts.evidenceEpisodeOpen) return 'stale';
  return 'held';
}

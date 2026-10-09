/**
 * Feedback triage (docs/specs/feedback-triage-and-execution.md, Phase 1: §1–§3, §5–§7).
 *
 * Runs only on the drain's fenced canonical owner. Each tick: brings held/ignored items
 * back on their timers or on new reports (throttled), lets a registered frontier model
 * decide work/hold/ignore for untriaged items within deterministic floors, records the
 * decision in the triage tables (never Cluster.status, report statuses or readiness),
 * maps it onto the feedback Initiative (work: class-review done; hold/ignore: paused),
 * and keeps the self-heal ladder, ignore-rate brake, shadow ignore and grading going.
 */
import { randomUUID } from 'node:crypto';
import type { IntelligenceProvider } from '../../core/types.js';
import type { Initiative, InitiativeTracker } from '../../core/InitiativeTracker.js';
import type { Cluster, FeedbackItem } from '../processor/types.js';
import type { AuthorityRecord, FeedbackDrainStore } from '../drain/FeedbackDrainStore.js';
import { StageBudgetExceeded, unitsThatFit, withStageBudget } from '../drain/stageBudget.js';
import { MIN_LATER_READINESS_CALL_MS } from '../drain/FeedbackDrainService.js';
import {
  FEEDBACK_TRIAGE_MODEL_TIMEOUT_MS, TRIAGE_PROMPT_OVERHEAD_CHARS, TriageContractViolation, TriageOutputRejected,
  secondOpinionSaysIgnore, type FeedbackTriageArbiter, type TriageCallResult,
} from './FeedbackTriageArbiter.js';
import { FeedbackTriageStore, type TriageRow } from './FeedbackTriageStore.js';
import type { FeedbackTriageAuditLog } from './FeedbackTriageAuditLog.js';
import { buildTriagePacket, nearestNeighbours, type BuiltPacket, type MergedPr, type TriagePacket } from './triagePacket.js';
import {
  DAY_MS, REQUEUE_THROTTLE_MS, RETRIAGE_SUBCAP, SECOND_OPINION_SUBCAP, WORK_QUEUE_CEILING_MS,
  applyFloors, applySecondOpinion, compareRank, evaluateBrake, holdIntervalDays, inQuietWindow, priorityBand,
  ruleDefault, severityTier, type FloorContext, type TriageModelRow,
} from './triageFloors.js';
import { TRIAGE_AUTHORITY_ID, triageBrakePlainWords } from './triageAuthorityProposal.js';

export const TRIAGE_UNUSABLE_LIMIT = 3;
export const SELF_HEAL_LADDER_MS = [30 * 60_000, 60 * 60_000, 4 * 60 * 60_000] as const;
export const SELF_HEAL_MAX_WALL_CLOCK_MS = 5.5 * 60 * 60_000;
export const SELF_HEAL_FLAP_WINDOW_MS = 7 * DAY_MS;
export const QUOTA_PAUSE_PERCENT = 75;
export const TICK_MIN_INTERVAL_MS = 30_000;
export const QUIET_GRADE_DAYS = 30;

export interface TriageLiveConfig {
  maxBatchChars: number;
  reportsPerItem: number;
  charsPerReport: number;
  maxCallsPerDay: number;
  /** Explicit config value; `false` is the kill switch over a PIN-approved live ignore. */
  ignoreLive?: boolean;
  actionTopicId?: number;
  timeZone?: string;
}

export const TRIAGE_CONFIG_DEFAULTS = { maxBatchChars: 24_000, reportsPerItem: 4, charsPerReport: 1_200, maxCallsPerDay: 150 } as const;

export function resolveTriageConfig(raw: Record<string, unknown> | undefined, execute: Record<string, unknown> | undefined): TriageLiveConfig {
  const int = (v: unknown, dflt: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
  };
  const topic = Number(execute?.actionTopicId);
  return {
    maxBatchChars: int(raw?.maxBatchChars, TRIAGE_CONFIG_DEFAULTS.maxBatchChars, 4_000, 200_000),
    reportsPerItem: int(raw?.reportsPerItem, TRIAGE_CONFIG_DEFAULTS.reportsPerItem, 1, 20),
    charsPerReport: int(raw?.charsPerReport, TRIAGE_CONFIG_DEFAULTS.charsPerReport, 200, 20_000),
    maxCallsPerDay: int(raw?.maxCallsPerDay, TRIAGE_CONFIG_DEFAULTS.maxCallsPerDay, 1, 10_000),
    ...(typeof raw?.ignoreLive === 'boolean' ? { ignoreLive: raw.ignoreLive } : {}),
    ...(Number.isSafeInteger(topic) && topic !== 0 ? { actionTopicId: topic } : {}),
  };
}

export interface AttentionInput {
  id: string; title: string; summary: string; description?: string;
  category: string; priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'; sourceContext?: string;
}

export interface FeedbackTriageServiceOptions {
  drainStore: FeedbackDrainStore;
  store: FeedbackTriageStore;
  audit: FeedbackTriageAuditLog;
  processing: { activeClusters(): Cluster[]; feedbackByCluster(): Map<string, FeedbackItem[]> };
  initiatives: Pick<InitiativeTracker, 'list' | 'get' | 'update' | 'setPhaseStatus'>;
  arbiter: FeedbackTriageArbiter | null;
  /** A provider of a model family different from `excludeFramework`, or null when none is available. */
  secondOpinion: (excludeFramework: string) => IntelligenceProvider | null;
  ownerHost: string;
  ownerEpoch: () => number;
  isCanonicalOwner: () => boolean;
  config: () => TriageLiveConfig;
  /** Highest used percent across the serving account's usage windows; null when it cannot be read. */
  quotaUsedPercent: (framework: string) => Promise<number | null>;
  /** Merged PRs of the last 30 days (one `gh` call); null on error. */
  listMergedPrs: () => Promise<MergedPr[] | null>;
  /** Phase 1 ships no executor: it is always unavailable (`not-built`). */
  executorStatus: () => { available: boolean; reason: string };
  raiseAttention: (item: AttentionInput) => Promise<void>;
  reportDegradation: (event: { feature: string; primary: string; fallback: string; reason: string; impact: string }) => void;
  sendToTopic?: (topicId: number, text: string) => Promise<void>;
  dashboardLink: () => string;
  maxWallClockMs?: number;
  clock?: () => number;
}

export interface TriageTickResult {
  runId: string;
  result: 'succeeded' | 'no-op' | 'degraded';
  reason?: string;
  decided: number;
  requeued: number;
  calls: number;
}

interface SelfHealState {
  generation: number;
  state: 'self-healing' | 'exhausted';
  startedAt: number;
  attempts: number;
  nextProbeAt: number;
}

type AuthorityState = 'awaiting-approval' | 'active' | 'paused' | 'self-healing' | 'exhausted' | 'binding-stale';

interface Candidate {
  row: TriageRow;
  cluster: Cluster;
  initiative: Initiative;
  retriage: boolean;
  alone: boolean;
}

export class FeedbackTriageService {
  private readonly now: () => number;
  private running = false;
  private lastStartedAt = 0;
  /** Wall-clock deadline of the tick in flight; every model call checks it first. */
  private tickDeadline = 0;

  constructor(private readonly opts: FeedbackTriageServiceOptions) {
    this.now = opts.clock ?? Date.now;
  }

  // ── authority ────────────────────────────────────────────────────────────────

  authority(): AuthorityRecord | null { return this.opts.drainStore.getAuthority(TRIAGE_AUTHORITY_ID); }

  authorityState(): { state: AuthorityState; reason: string | null; generation: number | null } {
    const authority = this.authority();
    if (!authority || authority.revoked) return { state: 'awaiting-approval', reason: authority ? 'revoked' : 'not-approved', generation: authority?.generation ?? null };
    if (!this.opts.drainStore.authorityOwnerCurrent(authority, this.opts.ownerHost, this.opts.ownerEpoch())) {
      return { state: 'binding-stale', reason: 'owner-binding-changed', generation: authority.generation };
    }
    const posture = this.opts.drainStore.authorityPosture(authority.authorityId, authority.generation);
    if (posture.mode === 'proposal-only') return { state: 'paused', reason: posture.reason, generation: authority.generation };
    const heal = this.selfHeal();
    if (heal && heal.generation === authority.generation) return { state: heal.state, reason: 'authority-unusable', generation: authority.generation };
    return { state: 'active', reason: null, generation: authority.generation };
  }

  private selfHeal(): SelfHealState | null { return this.opts.store.metaJson<SelfHealState>('self_heal'); }

  /** ignore is live only with the PIN-bound record AND no explicit config kill switch. */
  ignoreLive(): boolean {
    return this.opts.store.metaJson<{ enabled: boolean }>('ignore_live')?.enabled === true && this.opts.config().ignoreLive !== false;
  }

  // ── tick admission (owner-only, single-flight, rate-limited) ─────────────────

  /** Admit a tick and run it in the background (HTTP returns 202 with the run id). */
  acceptTick(): { status: 202 | 409 | 429; body: Record<string, unknown> } {
    if (!this.opts.isCanonicalOwner()) return { status: 409, body: { error: 'not-canonical-owner' } };
    if (this.running) return { status: 409, body: { error: 'tick-in-flight' } };
    if (this.now() - this.lastStartedAt < TICK_MIN_INTERVAL_MS) return { status: 429, body: { error: 'rate-limited', retryAfterMs: TICK_MIN_INTERVAL_MS - (this.now() - this.lastStartedAt) } };
    const runId = `triage-run:${randomUUID()}`;
    this.running = true;
    this.lastStartedAt = this.now();
    setImmediate(() => { void this.runTick(runId).catch(() => { /* recorded in last_tick */ }); });
    return { status: 202, body: { runId, accepted: true } };
  }

  /** Synchronous variant for tests and the job-less path; same admission rules. */
  async tick(): Promise<TriageTickResult> {
    if (!this.opts.isCanonicalOwner()) return { runId: '', result: 'degraded', reason: 'not-canonical-owner', decided: 0, requeued: 0, calls: 0 };
    if (this.running) return { runId: '', result: 'no-op', reason: 'tick-in-flight', decided: 0, requeued: 0, calls: 0 };
    this.running = true;
    this.lastStartedAt = this.now();
    return this.runTick(`triage-run:${randomUUID()}`);
  }

  private async runTick(runId: string): Promise<TriageTickResult> {
    const out: TriageTickResult = { runId, result: 'no-op', decided: 0, requeued: 0, calls: 0 };
    const startedAt = this.now();
    const epoch = this.opts.ownerEpoch();
    try {
      await this.tickBody(runId, epoch, startedAt, out);
    } catch (error) {
      out.result = 'degraded';
      out.reason = error instanceof Error ? error.message.slice(0, 200) : 'triage-tick-failed';
      this.opts.audit.append('tick-error', { runId, reason: out.reason });
    } finally {
      this.running = false;
      try {
        this.opts.store.fenced(epoch, () => this.opts.store.setMeta('last_tick', JSON.stringify({ ...out, startedAt, finishedAt: this.now() })));
      } catch { /* @silent-fallback-ok: a stale-epoch writer must not record a tick; the owner's next tick does */ }
    }
    return out;
  }

  private async tickBody(runId: string, epoch: number, startedAt: number, out: TriageTickResult): Promise<void> {
    const maxWallClockMs = Math.min(110_000, this.opts.maxWallClockMs ?? 110_000);
    const deadline = startedAt + maxWallClockMs;
    this.tickDeadline = deadline;
    this.opts.audit.prunePackets();
    this.opts.audit.pruneRotated();

    const authority = this.authority();
    const state = this.authorityState();
    if (!authority || state.state === 'awaiting-approval' || state.state === 'binding-stale' || state.state === 'paused' || state.state === 'exhausted') {
      out.reason = `authority-${state.state}`;
      return;
    }
    if (!this.opts.arbiter) { out.reason = 'no-intelligence-provider'; out.result = 'degraded'; return; }
    // A new authority generation (a fresh approval) starts with a clean unusable count and no
    // self-heal episode: those belonged to the previous approval.
    if (this.opts.store.meta('state_generation') !== String(authority.generation)) {
      this.opts.store.fenced(epoch, () => {
        this.opts.store.setMeta('consecutive_unusable', '0');
        this.opts.store.setMeta('self_heal', 'null');
        this.opts.store.setMeta('state_generation', String(authority.generation));
      });
    }
    try { this.opts.arbiter.checkAuthority(authority); } catch (error) {
      if (error instanceof TriageContractViolation) { await this.contractViolation(authority, error, runId); out.result = 'degraded'; out.reason = 'authority-mismatch'; return; }
      throw error;
    }

    // Sync the set of feedback Initiatives into the triage record.
    const clusters = this.opts.processing.activeClusters();
    const clusterById = new Map(clusters.map((c) => [c.clusterId, c]));
    const initiatives = this.feedbackInitiatives();
    for (const initiative of initiatives) {
      const clusterId = this.clusterIdFor(initiative);
      const cluster = clusterId ? clusterById.get(clusterId) : undefined;
      if (!clusterId || !cluster) continue;
      this.opts.store.ensure(epoch, {
        initiativeId: initiative.id, clusterId, feedbackWorkKey: initiative.feedbackWorkKey!,
        firstSeenAt: parseTime(cluster.createdAt, this.now()), reportCount: reportCountOf(cluster),
      });
    }
    const initiativeById = new Map(initiatives.map((i) => [i.id, i]));

    // Work-queue ceiling clock pauses while the executor is unavailable (Phase 1: always).
    const executor = this.opts.executorStatus();
    this.opts.store.pauseWorkClock(epoch, !executor.available);

    // Ignore-rate brake (floor 8) and its episode transitions.
    const brake = this.updateBrake(epoch);

    out.requeued = this.comeBack(epoch, initiativeById, clusterById, brake.engaged);

    // Spend: subscription quota pause — checked before ANY model call, the self-heal canary included (≥75% of either window, or unreadable).
    const used = await this.opts.quotaUsedPercent(authority.provider).catch(() => null);
    if (used === null || used >= QUOTA_PAUSE_PERCENT) {
      out.reason = used === null ? 'quota-unreadable-pause' : 'quota-pause';
      this.opts.store.fenced(epoch, () => this.opts.store.setMeta('quota_pause', JSON.stringify({ at: this.now(), usedPercent: used })));
      return;
    }
    this.opts.store.fenced(epoch, () => this.opts.store.setMeta('quota_pause', 'null'));

    // Self-heal ladder (§6): while healing, only the canary runs, on schedule.
    const heal = this.selfHeal();
    if (heal && heal.generation === authority.generation && heal.state === 'self-healing') {
      if (this.now() < heal.nextProbeAt) { out.reason = 'authority-self-healing'; return; }
      const resumed = await this.probe(authority, heal, epoch, runId, out);
      if (!resumed) { out.reason = 'authority-self-healing'; return; }
    }

    const candidates = this.selectCandidates(initiativeById, clusterById);
    if (candidates.length === 0) { this.gradeQuietDecisions(epoch, clusterById); await this.weeklySample(authority, epoch, out); return; }

    const mergedPrs = await this.opts.listMergedPrs().catch(() => null);
    const byCluster = this.opts.processing.feedbackByCluster();
    const tickId = runId;
    const cfg = this.opts.config();
    const batches = this.formBatches(candidates, byCluster, clusters, mergedPrs, cfg, authority);
    let observedMs = 0;
    let observedChars = 0;
    let unusableThisTick = false;
    for (const batch of batches) {
      const remaining = deadline - this.now();
      const batchChars = batch.reduce((sum, b) => sum + b.built.chars, 0);
      const fits = unitsThatFit(remaining, observedMs, observedChars, batchChars);
      if (remaining <= 0 || fits < batchChars || (out.calls > 0 && remaining < MIN_LATER_READINESS_CALL_MS)) { out.reason ??= 'triage-time-exhausted-rest-due'; break; }
      const retriage = batch.some((b) => b.candidate.retriage);
      /* @self-action-controller: feedback-triage-tick */
      if (!this.reserveCall(authority, epoch, retriage ? 'retriage' : null)) { out.reason = 'call-cap-reached'; break; }
      out.calls++;
      const started = this.now();
      let call: TriageCallResult | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2 && !call; attempt++) {
        if (attempt === 1 && !this.reserveCall(authority, epoch, retriage ? 'retriage' : null)) break;
        if (attempt === 1) out.calls++;
        try {
          call = await withStageBudget('triage-authority', () => this.opts.arbiter!.decideBatch(authority, batch.map((b) => b.built.packet),
            { timeoutMs: FEEDBACK_TRIAGE_MODEL_TIMEOUT_MS }), Math.min(FEEDBACK_TRIAGE_MODEL_TIMEOUT_MS + 5_000, Math.max(1, deadline - this.now())), this.now);
        } catch (error) {
          lastError = error;
          if (error instanceof TriageContractViolation) {
            await this.contractViolation(authority, error, runId);
            out.result = 'degraded'; out.reason = 'authority-mismatch';
            return;
          }
          if (error instanceof StageBudgetExceeded && deadline - this.now() < MIN_LATER_READINESS_CALL_MS) break;
        }
      }
      if (!call) {
        unusableThisTick = true;
        const check = lastError instanceof TriageOutputRejected ? lastError.check : lastError instanceof Error ? lastError.name : 'unknown';
        this.opts.audit.append('batch-unusable', { runId, items: batch.map((b) => b.candidate.row.initiativeId), check });
        await this.recordUnusable(authority, epoch, runId);
        out.result = 'degraded'; out.reason = 'triage-output-unusable';
        if (this.selfHeal()) return;
        continue;
      }
      this.opts.store.fenced(epoch, () => this.opts.store.setMeta('consecutive_unusable', '0'));
      observedMs += this.now() - started;
      observedChars += batchChars;
      // Floor 9 reads the report count at write time.
      const fresh = new Map(this.opts.processing.activeClusters().map((c) => [c.clusterId, c]));
      for (const row of call.rows) {
        const item = batch.find((b) => b.built.packet.clusterId === row.clusterId)!;
        const decided = await this.applyDecision(item.candidate, item.built, row, call, authority, epoch, tickId, brake.engaged, fresh);
        if (decided) out.decided++;
      }
    }
    if (out.decided > 0 && !unusableThisTick) out.result = 'succeeded';
    else if (out.decided > 0) out.result = 'degraded';
    this.gradeQuietDecisions(epoch, clusterById);
    await this.weeklySample(authority, epoch, out);
  }

  private reserveCall(authority: AuthorityRecord, epoch: number, subcap: 'retriage' | 'second-opinion' | 'grading' | null, subcapLimit?: number): boolean {
    const cfg = this.opts.config();
    if (subcap) {
      const limit = subcapLimit ?? (subcap === 'retriage' ? RETRIAGE_SUBCAP : subcap === 'second-opinion' ? SECOND_OPINION_SUBCAP : 25);
      if (this.opts.store.subcapUsed(subcap) + 1 > limit) return false;
    }
    if (!this.opts.drainStore.reserveAuthorityCalls(authority, 1, cfg.maxCallsPerDay, this.now())) return false;
    if (subcap) this.opts.store.reserveSubcap(epoch, subcap, 1, subcapLimit ?? (subcap === 'retriage' ? RETRIAGE_SUBCAP : subcap === 'second-opinion' ? SECOND_OPINION_SUBCAP : 25));
    return true;
  }

  // ── selection, packets and batches ───────────────────────────────────────────

  private feedbackInitiatives(): Initiative[] {
    return this.opts.initiatives.list({ kind: 'task' }).filter((i) => typeof i.feedbackWorkKey === 'string' && i.feedbackWorkKey.length > 0);
  }

  private clusterIdFor(initiative: Initiative): string | null {
    const work = initiative.feedbackWorkKey ? this.opts.drainStore.workByKey(initiative.feedbackWorkKey) : null;
    if (work?.clusterId) return work.clusterId;
    const link = (initiative.links ?? []).find((l) => l.label === 'Feedback cluster');
    return link?.ref ? String(link.ref) : null;
  }

  private selectCandidates(initiativeById: Map<string, Initiative>, clusterById: Map<string, Cluster>): Candidate[] {
    const out: Candidate[] = [];
    for (const row of this.opts.store.inState('untriaged', 'queued')) {
      const initiative = initiativeById.get(row.initiativeId);
      const cluster = clusterById.get(row.clusterId);
      if (!initiative || !cluster) continue;
      out.push({ row, cluster, initiative, retriage: row.state === 'queued', alone: row.truncatedRetry });
    }
    // Truncated re-tries first (each alone), then oldest first-seen, so a canonical item is
    // decided before its later duplicates.
    return out.sort((a, b) => Number(b.alone) - Number(a.alone) || a.row.firstSeenAt - b.row.firstSeenAt || a.row.initiativeId.localeCompare(b.row.initiativeId));
  }

  private formBatches(candidates: Candidate[], byCluster: Map<string, FeedbackItem[]>, clusters: Cluster[], mergedPrs: MergedPr[] | null,
    cfg: TriageLiveConfig, authority: AuthorityRecord): Array<Array<{ candidate: Candidate; built: BuiltPacket }>> {
    const budget = Math.max(1_000, cfg.maxBatchChars - TRIAGE_PROMPT_OVERHEAD_CHARS);
    const dispositionOf = (clusterId: string) => this.opts.store.byCluster(clusterId)?.state ?? null;
    const batches: Array<Array<{ candidate: Candidate; built: BuiltPacket }>> = [];
    let current: Array<{ candidate: Candidate; built: BuiltPacket }> = [];
    let used = 0;
    const maxItems = Math.min(50, Math.max(1, authority.maxBatch));
    for (const candidate of candidates) {
      const built = buildTriagePacket({
        cluster: candidate.cluster,
        reports: byCluster.get(candidate.cluster.clusterId) ?? [],
        neighbours: nearestNeighbours(candidate.cluster, clusters, dispositionOf),
        mergedPrs,
        options: { reportsPerItem: cfg.reportsPerItem, charsPerReport: cfg.charsPerReport },
        ...(candidate.alone ? { alone: { maxChars: budget } } : {}),
        ...(candidate.row.holdCount >= 3 ? { holdHistory: { holds: candidate.row.holdCount, lastReason: candidate.row.reason || null } } : {}),
        operatorOverride: candidate.row.operatorOverride,
        now: this.now(),
      });
      if (candidate.alone) { batches.push([{ candidate, built }]); continue; }
      if (current.length > 0 && (used + built.chars > budget || current.length >= maxItems)) { batches.push(current); current = []; used = 0; }
      current.push({ candidate, built });
      used += built.chars;
    }
    if (current.length > 0) batches.push(current);
    // Re-triage and first-time items go in separate calls so the re-triage sub-cap counts calls exactly.
    return batches.flatMap((batch) => {
      const re = batch.filter((b) => b.candidate.retriage);
      const fresh = batch.filter((b) => !b.candidate.retriage);
      return [fresh, re].filter((part) => part.length > 0);
    });
  }

  // ── applying one decision ────────────────────────────────────────────────────

  private async applyDecision(candidate: Candidate, built: BuiltPacket, row: TriageModelRow, call: TriageCallResult, authority: AuthorityRecord,
    epoch: number, tickId: string, brakeActive: boolean, fresh: Map<string, Cluster>): Promise<boolean> {
    const now = this.now();
    const reportCount = reportCountOf(candidate.cluster);
    const eligible = new Set<string>();
    for (const n of built.packet.neighbours) {
      const neighbour = this.opts.store.byCluster(n.clusterId);
      if (neighbour && (neighbour.state === 'work' || neighbour.state === 'hold') && neighbour.decidedTick !== tickId) eligible.add(n.clusterId);
    }
    const ctx: FloorContext = {
      reportCount, truncated: built.truncated, credentialShaped: built.credentialShaped, keywordFloor: built.keywordFloor,
      eligibleDuplicateTargets: eligible, exactIdPrs: built.exactIdPrs, brakeActive, ignoreLive: this.ignoreLive(),
    };
    let outcome = applyFloors(row, ctx);
    if (candidate.alone) outcome = { ...outcome, floors: [...outcome.floors, 'f4-retried-alone'] };
    if (outcome.needsSecondOpinion) {
      let verdict: boolean | null = null;
      const remaining = this.tickDeadline - this.now();
      if (remaining < MIN_LATER_READINESS_CALL_MS) {
        // No time left in this tick: treated as "no second opinion" → held needs-review (safe side).
        outcome = { ...outcome, floors: [...outcome.floors, 'f3-out-of-time'] };
      } else {
        const provider = this.opts.secondOpinion(authority.provider);
        if (provider && this.reserveCall(authority, epoch, 'second-opinion')) {
          verdict = await this.boundedSecondOpinion(provider, built.packet, authority.provider, remaining);
        }
      }
      outcome = applySecondOpinion(outcome, row, ctx, verdict);
    }
    // Floor 9: stale-write guard.
    const nowCount = reportCountOf(fresh.get(candidate.cluster.clusterId) ?? candidate.cluster);
    if (nowCount !== reportCount && outcome.disposition !== 'work') {
      this.opts.store.requeue(epoch, candidate.row.initiativeId, 'stale-write', { exempt: true, countThrottle: false });
      this.opts.audit.append('stale-write-requeued', { initiativeId: candidate.row.initiativeId, bound: reportCount, now: nowCount });
      return false;
    }
    const state = outcome.disposition === 'work' ? 'work' : outcome.disposition === 'hold' ? 'hold' : 'ignored';
    const holdCount = candidate.row.holdCount + (state === 'hold' ? 1 : 0);
    const nextReviewAt = state === 'hold' && outcome.holdBaseDays !== null ? now + holdIntervalDays(holdCount, outcome.holdBaseDays) * DAY_MS : null;
    const packetRef = FeedbackTriageStore.packetRef(tickId, candidate.row.initiativeId);
    try { this.opts.audit.writePacket(packetRef, built.packet); } catch (error) {
      this.opts.audit.append('packet-write-failed', { initiativeId: candidate.row.initiativeId, error: error instanceof Error ? error.name : 'unknown' });
    }
    const priorDecision = this.opts.store.latestDecisionFor(candidate.row.initiativeId);
    const expectedStatus = state === 'work' ? 'active' : 'paused';
    const sequence = this.opts.store.writeDecision(epoch, {
      initiativeId: candidate.row.initiativeId, tickId, state, reason: outcome.reason, wouldIgnoreReason: outcome.wouldIgnoreReason,
      severity: row.severity, priority: row.priority, confidence: row.confidence, effort: row.effort, needsSpec: row.needsSpec,
      userFacing: row.userFacing, summary: row.summary, brief: row.brief, duplicateOf: outcome.duplicateApplied ? row.duplicateOf : null,
      fixedBy: row.reason === 'already-fixed' && !outcome.floors.includes('f6-fix-unverified') ? row.fixedBy : null,
      evidenceComplete: outcome.evidenceComplete, rankTier: severityTier(row.severity, outcome.singleReportCritical), rankBand: priorityBand(row.priority),
      singleReportCritical: outcome.singleReportCritical, floors: outcome.floors,
      ruleDefault: ruleDefault({ reportCount, firstSeenAt: candidate.row.firstSeenAt, keywordFloor: built.keywordFloor, now }),
      boundReportCount: reportCount, nextReviewAt, authorityGeneration: authority.generation, packetRef, correlationId: call.correlationId,
      expectedInitiativeStatus: expectedStatus, modelDisposition: row.disposition, wouldIgnore: outcome.countedAsIgnore,
      shadow: outcome.reason === 'ignore-shadow', keywordFloor: built.keywordFloor,
      duplicateReports: outcome.duplicateApplied ? reportCount : undefined,
      workClockPaused: !this.opts.executorStatus().available,
    });
    // A later work decision after new reports supersedes an earlier hold/ignore; it is not "wrong".
    if (priorDecision && state === 'work' && priorDecision.disposition !== 'work' && candidate.row.requeueReason === 'new-reports') {
      this.opts.store.recordGrade(epoch, { decisionSequence: priorDecision.sequence, rule: 'superseded-by-new-reports', grade: 'superseded', strength: 'weak', disposition: priorDecision.disposition, shadow: priorDecision.shadow });
    }
    await this.mapInitiative(candidate.initiative, state, epoch);
    this.opts.audit.append('decision', {
      initiativeId: candidate.row.initiativeId, clusterId: candidate.row.clusterId, sequence, disposition: state, reason: outcome.reason,
      modelDisposition: row.disposition, severity: row.severity, priority: row.priority, confidence: row.confidence, floors: outcome.floors,
      ruleDefault: ruleDefault({ reportCount, firstSeenAt: candidate.row.firstSeenAt, keywordFloor: built.keywordFloor, now }),
      packetRef, retriage: candidate.retriage, truncated: built.truncated,
    });
    return true;
  }

  /** A second-opinion call cut off at the tick's remaining time; a timeout reads as no answer (null). */
  private async boundedSecondOpinion(provider: IntelligenceProvider, packet: TriagePacket, authorityFramework: string, remainingMs: number): Promise<boolean | null> {
    try {
      return await withStageBudget('triage-second-opinion', () => secondOpinionSaysIgnore(provider, packet, authorityFramework),
        Math.min(FEEDBACK_TRIAGE_MODEL_TIMEOUT_MS + 5_000, Math.max(1, remainingMs)), this.now);
    } catch { return null; }
  }

  /** work: Initiative stays active, class-review phase → done. hold/ignore: paused. Never archived/abandoned. */
  private async mapInitiative(initiative: Initiative, state: 'work' | 'hold' | 'ignored', epoch: number): Promise<void> {
    try {
      const current = this.opts.initiatives.get(initiative.id) ?? initiative;
      if (state === 'work') {
        if (current.status !== 'active') await this.opts.initiatives.update(initiative.id, { status: 'active' });
        const phase = current.phases.find((p) => p.id === 'class-review');
        if (phase && phase.status !== 'done') await this.opts.initiatives.setPhaseStatus(initiative.id, 'class-review', 'done');
      } else if (current.status !== 'paused') {
        await this.opts.initiatives.update(initiative.id, { status: 'paused' });
      }
    } catch (error) {
      // The decision stands; without a confirmed status there is nothing an operator changed.
      this.opts.store.fenced(epoch, () => this.opts.store.clearExpectedStatus(initiative.id));
      this.opts.audit.append('initiative-map-failed', { initiativeId: initiative.id, state, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  // ── coming back, overrides, ceiling ──────────────────────────────────────────

  private comeBack(epoch: number, initiativeById: Map<string, Initiative>, clusterById: Map<string, Cluster>, brakeEngaged: boolean): number {
    const now = this.now();
    let requeued = 0;
    const throttled = (row: TriageRow) => row.lastRequeuedAt !== null && now - row.lastRequeuedAt < REQUEUE_THROTTLE_MS;
    for (const row of this.opts.store.inState('work', 'hold', 'ignored')) {
      const initiative = initiativeById.get(row.initiativeId);
      const cluster = clusterById.get(row.clusterId);
      if (!initiative || !cluster) continue;
      // Operator changes win: a status the operator changed is recorded and re-triaged with the override.
      if (row.expectedInitiativeStatus && initiative.status !== row.expectedInitiativeStatus) {
        const override = `operator changed status ${row.expectedInitiativeStatus} -> ${initiative.status}`;
        if (['completed', 'archived', 'abandoned'].includes(initiative.status)) {
          this.opts.store.recordOverride(epoch, row.initiativeId, override);
          this.opts.audit.append('operator-override', { initiativeId: row.initiativeId, to: initiative.status, requeued: false });
          continue;
        }
        if (throttled(row)) continue;
        this.opts.store.recordOverride(epoch, row.initiativeId, override);
        this.opts.store.requeue(epoch, row.initiativeId, 'operator-override');
        this.opts.audit.append('operator-override', { initiativeId: row.initiativeId, to: initiative.status, requeued: true });
        requeued++;
        continue;
      }
      let reason: string | null = null;
      const newReports = reportCountOf(cluster) > row.boundReportCount;
      if ((row.state === 'hold' || row.state === 'ignored') && newReports) reason = 'new-reports';
      else if (row.state === 'hold' && row.reason === 'ignore-rate-brake' && !brakeEngaged) reason = 'brake-ended';
      else if (row.state === 'hold' && row.reason !== 'ignore-rate-brake' && row.nextReviewAt !== null && row.nextReviewAt <= now) reason = 'review-due';
      else if (row.state === 'hold' && row.reason === 'evidence-truncated' && !row.floors.includes('f4-retried-alone')) reason = 'truncated-retry';
      else if (row.state === 'work' && row.workSince !== null) {
        const pausedNow = row.workPausedSince !== null ? now - row.workPausedSince : 0;
        if (now - row.workSince - row.workPausedMs - pausedNow > WORK_QUEUE_CEILING_MS) reason = 'work-queue-ceiling';
      }
      if (!reason) continue;
      const truncatedRetry = reason === 'truncated-retry';
      if (!truncatedRetry && throttled(row)) continue;
      this.opts.store.requeue(epoch, row.initiativeId, reason, { truncatedRetry, countThrottle: !truncatedRetry });
      this.opts.audit.append('requeued', { initiativeId: row.initiativeId, reason });
      requeued++;
    }
    return requeued;
  }

  // ── ignore-rate brake ────────────────────────────────────────────────────────

  private updateBrake(epoch: number): { engaged: boolean } {
    const prior = this.opts.store.metaJson<{ engaged: boolean; since: number | null }>('ignore_brake') ?? { engaged: false, since: null };
    const window = this.opts.store.brakeWindow(this.now());
    const verdict = evaluateBrake({ ...window, totalDecisions: window.total, baseline: this.opts.store.baselineIgnoreShare(), engaged: prior.engaged });
    if (verdict.engaged !== prior.engaged) {
      this.opts.store.fenced(epoch, () => this.opts.store.setMeta('ignore_brake', JSON.stringify({ engaged: verdict.engaged, since: this.now(), share: verdict.share })));
      this.opts.audit.append(verdict.engaged ? 'ignore-brake-engaged' : 'ignore-brake-released', { share: verdict.share, threshold: verdict.threshold });
      if (verdict.engaged) {
        this.opts.reportDegradation({
          feature: 'feedback-triage:ignore-rate',
          primary: 'Apply the triage model\'s ignore decisions',
          fallback: 'New ignores are held (reason ignore-rate-brake) until the ignore share falls back',
          reason: `ignore share ${(verdict.share ?? 0).toFixed(2)} exceeds ${verdict.threshold.toFixed(2)}`,
          impact: 'Items the model would ignore stay parked instead; nothing is lost.',
        });
      }
    }
    return { engaged: verdict.engaged };
  }

  // ── self-heal before notify (§6) ─────────────────────────────────────────────

  private async recordUnusable(authority: AuthorityRecord, epoch: number, runId: string): Promise<void> {
    const count = Number(this.opts.store.meta('consecutive_unusable') ?? 0) + 1;
    this.opts.store.fenced(epoch, () => this.opts.store.setMeta('consecutive_unusable', String(count)));
    if (count < TRIAGE_UNUSABLE_LIMIT || this.selfHeal()?.generation === authority.generation) return;
    const now = this.now();
    const episodes = (this.opts.store.metaJson<number[]>('self_heal_episodes') ?? []).filter((t) => now - t < SELF_HEAL_FLAP_WINDOW_MS);
    episodes.push(now);
    const heal: SelfHealState = { generation: authority.generation, state: 'self-healing', startedAt: now, attempts: 0, nextProbeAt: now + SELF_HEAL_LADDER_MS[0] };
    this.opts.store.fenced(epoch, () => {
      this.opts.store.setMeta('self_heal', JSON.stringify(heal));
      this.opts.store.setMeta('self_heal_episodes', JSON.stringify(episodes));
    });
    this.opts.audit.append('self-heal-start', { runId, generation: authority.generation, episodes: episodes.length, dedupeKey: 'feedback-triage:authority-unusable' });
    this.opts.reportDegradation({
      feature: 'feedback-triage:authority-unusable',
      primary: 'Triage feedback work items with the approved model',
      fallback: 'Items stay untriaged while the model is re-probed after 30 min, 1 h and 4 h',
      reason: `${TRIAGE_UNUSABLE_LIMIT} consecutive triage batches produced no usable answer`,
      impact: 'No work/hold/ignore decisions until a probe succeeds; nothing is lost.',
    });
    if (episodes.length >= 3) {
      await this.attention({
        id: `feedback-triage:authority-unusable:flapping:${episodes[0]}`,
        title: 'Feedback triage keeps failing',
        summary: 'The feedback sorting model stopped giving usable answers three times in a week.',
        description: 'Three self-heal episodes started within 7 days. Triage keeps retrying on its own; this flapping pattern may need a different model or a fresh approval on the dashboard Feedback Drain tab.',
        category: 'monitoring', priority: 'NORMAL', sourceContext: 'feedback-triage:authority-unusable',
      });
    }
  }

  /** One canary probe; true when triage may resume this tick. */
  private async probe(authority: AuthorityRecord, heal: SelfHealState, epoch: number, runId: string, out: TriageTickResult): Promise<boolean> {
    /* @self-action-controller: feedback-triage-self-heal-probe */
    if (!this.reserveCall(authority, epoch, null)) return false;
    out.calls++;
    try {
      await this.opts.arbiter!.canary(authority);
      this.opts.store.fenced(epoch, () => { this.opts.store.setMeta('self_heal', 'null'); this.opts.store.setMeta('consecutive_unusable', '0'); });
      this.opts.audit.append('self-heal-resumed', { runId, attempts: heal.attempts + 1 });
      return true;
    } catch (error) {
      if (error instanceof TriageContractViolation) { await this.contractViolation(authority, error, runId); return false; }
      const attempts = heal.attempts + 1;
      const now = this.now();
      if (attempts >= SELF_HEAL_LADDER_MS.length || now - heal.startedAt >= SELF_HEAL_MAX_WALL_CLOCK_MS) {
        this.opts.store.fenced(epoch, () => this.opts.store.setMeta('self_heal', JSON.stringify({ ...heal, attempts, state: 'exhausted', nextProbeAt: 0 })));
        this.opts.audit.append('self-heal-exhausted', { runId, attempts });
        await this.attention({
          id: `feedback-triage:authority-unusable:exhausted:${heal.startedAt}`,
          title: 'Feedback triage needs a look',
          summary: triageBrakePlainWords('triage-self-heal-exhausted'),
          description: 'The feedback sorting model gave no usable answer on any of three automatic re-checks (30 min, 1 h, 4 h). Items stay untriaged. A fresh approval on the dashboard Feedback Drain tab starts triage again.',
          category: 'monitoring', priority: 'HIGH', sourceContext: 'feedback-triage:authority-unusable',
        });
      } else {
        this.opts.store.fenced(epoch, () => this.opts.store.setMeta('self_heal', JSON.stringify({ ...heal, attempts, nextProbeAt: now + SELF_HEAL_LADDER_MS[attempts] })));
        this.opts.audit.append('self-heal-probe-failed', { runId, attempts });
      }
      return false;
    }
  }

  /** A model/prompt/schema mismatch is not recoverable: demote and tell the operator now. */
  private async contractViolation(authority: AuthorityRecord, error: TriageContractViolation, runId: string): Promise<void> {
    try { this.opts.drainStore.demoteAuthority(authority.authorityId, authority.generation, 'triage-authority-mismatch'); } catch { /* @silent-fallback-ok: already inactive */ }
    this.opts.audit.append('authority-mismatch', { runId, check: error.check, generation: authority.generation });
    await this.attention({
      id: `feedback-triage:authority-mismatch:${authority.generation}`,
      title: 'Feedback triage paused: new approval needed',
      summary: triageBrakePlainWords('triage-authority-mismatch'),
      description: `Check failed: ${error.check}. Triage is paused until you approve the current model on the dashboard Feedback Drain tab (Triage section).`,
      category: 'monitoring', priority: 'HIGH', sourceContext: 'feedback-triage:authority-mismatch',
    });
  }

  private async attention(item: AttentionInput): Promise<void> {
    try { await this.opts.raiseAttention(item); } catch (error) {
      this.opts.audit.append('attention-failed', { id: item.id, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  // ── grading (triage-side record; headline uses strong only) ──────────────────

  /** After 30 quiet days an ignore/hold is `right (weak)` — reported separately, never counted for graduation. */
  private gradeQuietDecisions(epoch: number, clusterById: Map<string, Cluster>): void {
    for (const decision of this.opts.store.quietGradeCandidates(this.now() - QUIET_GRADE_DAYS * DAY_MS, 200)) {
      const cluster = clusterById.get(decision.clusterId);
      if (!cluster || reportCountOf(cluster) > decision.boundReportCount) continue;
      this.opts.store.recordGrade(epoch, { decisionSequence: decision.sequence, rule: 'quiet-30d', grade: 'right', strength: 'weak', disposition: decision.disposition, shadow: decision.shadow });
    }
  }

  /** Weekly cross-family re-judgment of up to 10 (25 in shadow) ignore/would-ignore decisions. */
  private async weeklySample(authority: AuthorityRecord, epoch: number, out: TriageTickResult): Promise<void> {
    // One sample per 7-day window. A window that runs out of tick time resumes on the next tick
    // instead of being marked done.
    let progress = this.opts.store.metaJson<{ windowStart: number; done: number; complete: boolean }>('grade_sample_progress');
    if (!progress || (progress.complete && this.now() - progress.windowStart >= 7 * DAY_MS)) progress = { windowStart: this.now(), done: 0, complete: false };
    if (progress.complete) return;
    const provider = this.opts.secondOpinion(authority.provider);
    if (!provider) return;
    const size = this.ignoreLive() ? 10 : 25;
    const save = () => this.opts.store.fenced(epoch, () => this.opts.store.setMeta('grade_sample_progress', JSON.stringify(progress)));
    for (const decision of this.opts.store.ungradedIgnoreDecisions(progress.windowStart, Math.max(0, size - progress.done))) {
      const remaining = this.tickDeadline - this.now();
      if (remaining < MIN_LATER_READINESS_CALL_MS) { save(); return; }
      const packet = decision.packetRef ? this.opts.audit.readPacket(decision.packetRef) as TriagePacket | null : null;
      progress.done++;
      if (!packet) continue;
      if (!this.reserveCall(authority, epoch, 'grading', size)) { progress.done--; save(); return; }
      out.calls++;
      const verdict = await this.boundedSecondOpinion(provider, packet, authority.provider, remaining);
      if (verdict === null) continue;
      this.opts.store.recordGrade(epoch, {
        decisionSequence: decision.sequence, rule: 'cross-family-sample', grade: verdict ? 'right' : 'wrong', strength: 'medium',
        disposition: decision.disposition, shadow: decision.shadow,
      });
    }
    progress.complete = true;
    save();
  }

  /** Shadow ignores with medium-or-strong grades: ≥30 graded with ≤10% wrong → recommend ignore going live. */
  ignoreLiveEvidence(): { graded: number; wrong: number; strong: number; medium: number; recommended: boolean } {
    let graded = 0, wrong = 0, strong = 0, medium = 0;
    for (const g of this.opts.store.gradeCounts()) {
      if (!g.shadow || g.disposition !== 'ignore' || g.strength === 'weak' || (g.grade !== 'right' && g.grade !== 'wrong')) continue;
      graded += g.n;
      if (g.grade === 'wrong') wrong += g.n;
      if (g.strength === 'strong') strong += g.n; else medium += g.n;
    }
    return { graded, wrong, strong, medium, recommended: graded >= 30 && wrong / graded <= 0.1 };
  }

  // ── read surfaces ────────────────────────────────────────────────────────────

  queue(): Array<Record<string, unknown>> {
    const initiatives = new Map(this.feedbackInitiatives().map((i) => [i.id, i]));
    const clusters = new Map(this.opts.processing.activeClusters().map((c) => [c.clusterId, c]));
    return this.opts.store.inState('work')
      .map((row) => ({ row, rank: {
        severityTier: row.rankTier ?? 9, priorityBand: row.rankBand ?? 9,
        effectiveRecurrence: reportCountOf(clusters.get(row.clusterId)) + row.duplicateBonus, firstSeenAt: row.firstSeenAt, id: row.initiativeId,
      } }))
      .sort((a, b) => compareRank(a.rank, b.rank))
      .map(({ row, rank }, index) => ({
        rank: index + 1, initiativeId: row.initiativeId, clusterId: row.clusterId,
        title: initiatives.get(row.initiativeId)?.title ?? null, summary: row.summary, severity: row.severity, priority: row.priority,
        effectiveRecurrence: rank.effectiveRecurrence, evidenceComplete: row.evidenceComplete, needsSpec: row.needsSpec,
        executionState: 'queued', prLink: null, decidedAt: row.decidedAt,
      }));
  }

  summary(): Record<string, unknown> {
    const rows = this.opts.store.all();
    const byState: Record<string, number> = { untriaged: 0, queued: 0, work: 0, hold: 0, ignored: 0 };
    const byReason: Record<string, number> = {};
    for (const row of rows) {
      byState[row.state] = (byState[row.state] ?? 0) + 1;
      if (row.state === 'hold' || row.state === 'ignored') byReason[`${row.state}:${row.reason}`] = (byReason[`${row.state}:${row.reason}`] ?? 0) + 1;
    }
    const now = this.now();
    const today = this.opts.store.decisionsSince(now - DAY_MS);
    const floorsToday: Record<string, number> = {};
    let keywordHits = 0;
    for (const d of today) {
      for (const f of d.floors) floorsToday[f] = (floorsToday[f] ?? 0) + 1;
      if (d.keywordFloor) keywordHits++;
    }
    const all = this.opts.store.decisionsSince(0);
    const agree = all.filter((d) => normalizeDisposition(d.modelDisposition) === d.ruleDefault).length;
    const work = rows.filter((r) => r.state === 'work');
    const oldestWork = work.reduce<number | null>((min, r) => (r.decidedAt !== null && (min === null || r.decidedAt < min) ? r.decidedAt : min), null);
    const authority = this.authority();
    const authorityState = this.authorityState();
    const grades: Record<string, Record<string, number>> = { strong: {}, medium: {}, weak: {} };
    let workRight = 0, workWrong = 0;
    for (const g of this.opts.store.gradeCounts()) {
      grades[g.strength][g.grade] = (grades[g.strength][g.grade] ?? 0) + g.n;
      if (g.disposition === 'work' && g.strength !== 'weak') { if (g.grade === 'right') workRight += g.n; if (g.grade === 'wrong') workWrong += g.n; }
    }
    const holdAll = all.filter((d) => normalizeDisposition(d.modelDisposition) === 'hold').length;
    const evidence = this.ignoreLiveEvidence();
    return {
      authority: authorityState.state,
      authorityReason: authorityState.reason,
      authorityGeneration: authorityState.generation,
      pausedBecause: authorityState.state === 'paused' ? triageBrakePlainWords(authorityState.reason ?? '') : null,
      counts: byState,
      byReason,
      lastTick: this.opts.store.metaJson('last_tick'),
      selfHeal: this.selfHeal(),
      quotaPause: this.opts.store.metaJson('quota_pause'),
      ignoreBrake: this.opts.store.metaJson('ignore_brake') ?? { engaged: false },
      floorsFiredToday: floorsToday,
      decisionsToday: today.length,
      keywordFloorHitRate: today.length ? keywordHits / today.length : null,
      ruleDefaultAgreement: all.length ? { agree, total: all.length, rate: agree / all.length } : null,
      // Second comparison baseline: "hold everything" agrees exactly where the model held.
      holdEverythingAgreement: all.length ? { agree: holdAll, total: all.length, rate: holdAll / all.length } : null,
      // Precision of work decisions, reported on its own (medium/strong grades only; none until outcomes exist).
      workPrecision: workRight + workWrong > 0 ? { right: workRight, wrong: workWrong, rate: workRight / (workRight + workWrong) } : null,
      callsUsedToday: authority ? this.opts.drainStore.authorityCallsToday(authority, now) : 0,
      maxCallsPerDay: this.opts.config().maxCallsPerDay,
      subcapsToday: { retriage: this.opts.store.subcapUsed('retriage'), secondOpinion: this.opts.store.subcapUsed('second-opinion'), grading: this.opts.store.subcapUsed('grading') },
      queueDepth: work.length,
      oldestQueuedAgeMs: oldestWork === null ? null : now - oldestWork,
      ignoreLive: this.ignoreLive(),
      ignoreLiveRecommended: evidence.recommended,
      ignoreLiveEvidence: evidence,
      grades,
      executor: this.opts.executorStatus(),
    };
  }

  // ── action list (§5) ─────────────────────────────────────────────────────────

  /** Compose the operator action list; null when nothing new needs the operator. */
  composeActionList(): { text: string; itemIds: string[]; metaKeys: string[] } | null {
    // Each entry carries the id or meta key it stamps, so only what is actually shown is stamped.
    const entries: Array<{ line: string; itemId?: string; metaKey?: string }> = [];
    const link = this.opts.dashboardLink();
    const state = this.authorityState();
    if (state.state === 'awaiting-approval' || state.state === 'binding-stale' || state.state === 'paused') {
      const key = `action_list:authority:${state.state}:${state.generation ?? 0}`;
      if (!this.opts.store.meta(key)) {
        entries.push({ line: `Approve the feedback sorting model (one PIN tap) so triage can start: ${link}`, metaKey: key });
      }
    }
    const holds = this.opts.store.inState('hold').filter((r) => r.reason === 'needs-review');
    const clusters = new Map(this.opts.processing.activeClusters().map((c) => [c.clusterId, c]));
    const initiatives = new Map(this.feedbackInitiatives().map((i) => [i.id, i]));
    let quietCount = 0;
    for (const row of holds) {
      if (row.notifiedAt !== null) continue;
      const serious = row.severity === 'critical' || row.severity === 'high' || reportCountOf(clusters.get(row.clusterId)) >= 2;
      if (!serious) { quietCount++; continue; }
      const title = initiatives.get(row.initiativeId)?.title ?? row.clusterId;
      entries.push({ line: `Held for review (${row.severity ?? 'unrated'}): ${title.slice(0, 120)} — ${link}`, itemId: row.initiativeId });
    }
    if (this.ignoreLiveEvidence().recommended && !this.ignoreLive() && !this.opts.store.meta('action_list:ignore-live-recommended')) {
      const e = this.ignoreLiveEvidence();
      entries.push({ line: `Ignore decisions look ready to go live: ${e.graded} checked (${e.strong} strong, ${e.medium} medium), ${e.wrong} wrong. Turn on with your PIN: ${link}`, metaKey: 'action_list:ignore-live-recommended' });
    }
    if (entries.length === 0) return null;
    const sent = entries.slice(0, 10);
    const shown = sent.map((entry) => entry.line);
    if (entries.length > 10) shown.push(`…and ${entries.length - 10} more in the triage queue: ${link}`);
    if (quietCount > 0) shown.push(`${quietCount} other item(s) are held for review; see the queue: ${link}`);
    return {
      text: ['Feedback triage — things that need you:', ...shown.map((l) => `• ${l}`)].join('\n'),
      itemIds: sent.flatMap((entry) => (entry.itemId ? [entry.itemId] : [])),
      metaKeys: sent.flatMap((entry) => (entry.metaKey ? [entry.metaKey] : [])),
    };
  }

  /** Send the action list at most once a day, never in the quiet window; stamps notifiedAt only after delivery. */
  async sendActionList(): Promise<{ sent: boolean; reason?: string; items?: number }> {
    if (!this.opts.isCanonicalOwner()) return { sent: false, reason: 'not-canonical-owner' };
    const cfg = this.opts.config();
    const nowDate = new Date(this.now());
    if (inQuietWindow(nowDate, cfg.timeZone)) return { sent: false, reason: 'quiet-window' };
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowDate);
    if (this.opts.store.meta('action_list:last_day') === day) return { sent: false, reason: 'already-sent-today' };
    const composed = this.composeActionList();
    if (!composed) return { sent: false, reason: 'nothing-new' };
    const epoch = this.opts.ownerEpoch();
    /* @self-action-controller: feedback-triage-action-list */
    if (cfg.actionTopicId !== undefined && this.opts.sendToTopic) {
      await this.opts.sendToTopic(cfg.actionTopicId, composed.text);
    } else {
      await this.opts.raiseAttention({
        id: `feedback-triage:action-list:${day}`, title: 'Feedback triage: things that need you',
        summary: composed.text.split('\n')[1]?.replace(/^• /, '').slice(0, 200) ?? 'Feedback triage action list',
        description: composed.text, category: 'feedback', priority: 'NORMAL', sourceContext: 'feedback-triage:action-list',
      });
    }
    this.opts.store.markNotified(epoch, composed.itemIds);
    this.opts.store.fenced(epoch, () => {
      for (const key of composed.metaKeys) this.opts.store.setMeta(key, String(this.now()));
      this.opts.store.setMeta('action_list:last_day', day);
    });
    this.opts.audit.append('action-list-sent', { items: composed.itemIds.length, extra: composed.metaKeys.length, viaTopic: cfg.actionTopicId !== undefined });
    return { sent: true, items: composed.itemIds.length + composed.metaKeys.length };
  }

  // ── PIN-bound authorities (§7, Frontloaded Decision 7) ───────────────────────

  setIgnoreLive(enabled: boolean, operatorDecisionRef: string): void {
    const epoch = this.opts.ownerEpoch();
    this.opts.store.fenced(epoch, () => this.opts.store.setMeta('ignore_live', JSON.stringify({ enabled, operatorDecisionRef, at: this.now() })));
    this.opts.audit.append('ignore-live-set', { enabled, operatorDecisionRef });
  }
}

function parseTime(value: unknown, fallback: number): number {
  const t = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(t) ? t : fallback;
}

export function reportCountOf(cluster: Cluster | undefined): number {
  return Math.max(1, Math.trunc(Number(cluster?.reportCount ?? 1)) || 1);
}

function normalizeDisposition(disposition: string): string { return disposition === 'ignored' ? 'ignore' : disposition; }

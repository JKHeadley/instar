/**
 * BenchmarkDivergenceAnalyzer — the stage-3 ANALYZE engine of the
 * Benchmark-Divergence Detector (docs/specs/benchmark-divergence-detector.md,
 * FD7/FD8/FD9/FD13).
 *
 * On the serving-lease holder only, each pass re-reads a ROLLING WINDOW of
 * matured days from the per-model rollup (never raw rows), pool-collects every
 * machine's matured-window aggregates (R2) through the FD9 clamps, compares
 * pool-merged grade-rates against the mirrored benchmark passRate (FD3), and
 * idempotently upserts findings carrying the ranked questions. Observe-only:
 * findings are advisory, and the analyzer NEVER touches the meter's raw
 * tables or gates any retention (FD7 — verdict-only coupling).
 *
 * dryRun (FD13, default true) = ZERO detector-owned durable writes: no
 * findings, no watermark, no history — would-analyze summaries are logged
 * content-free.
 */

import type { FeatureMetricsLedger } from './FeatureMetricsLedger.js';
import type { InstarConfig } from '../core/types.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import {
  computeVerdict,
  nextChronicStreak,
  questionsFor,
  clampPeerAggregates,
  clampPeerFinding,
  mergeFindingsByKey,
  utcDayKey,
  addDays,
  MODEL_MISSING,
  UNMAPPED_FLOOD_MODEL,
  type AggregateBucketRow,
  type OrphanCountRow,
  type FindingView,
  type DivergenceVerdict,
  type PreconditionReason,
} from '../core/benchmarkDivergenceCore.js';
import {
  ENROLLED_PAIRS,
  PROMPT_TEMPLATE_REGISTRY,
  normalizeModelId,
  liveTemplateHash,
  loadBenchmarkMirror,
  resolveMirrorPath,
  type BenchmarkMirror,
} from '../data/benchmarkDivergenceRegistry.js';

/* ── Micro-constants (FD12 — named code constants) ────────────────────────── */

/** One deadline for the whole peer fan-out (aggregates + finding seeds). */
export const POOL_COLLECT_DEADLINE_MS = 5_000;
/** Hard bound on peers contacted per pass (the fan-out stays bounded even on a large pool). */
export const MAX_PEERS_PER_COLLECT = 16;
/** Minimum interval between analysis passes (the POST rate-limit). */
export const ANALYZE_MIN_INTERVAL_MS = 5 * 60_000;
/**
 * Cadence jitter fraction (FD8 "±10% of cadence"): a cadence-triggered pass is
 * DELAYED by uniform(0, CADENCE_JITTER_FRACTION × cadence) so a fixed cron
 * schedule cannot systematically exclude a machine's awake window. (A
 * triggered pass can only move LATER, never earlier — the honest realizable
 * half of ±10%; the anti-systematic-exclusion property is what the jitter
 * exists for and is preserved.)
 */
export const CADENCE_JITTER_FRACTION = 0.1;

/* ── Resolved config (spec §Config surface — inline defaults) ─────────────── */

export interface BenchmarkDivergenceSettings {
  enabled: boolean;
  dryRun: boolean;
  divergenceThreshold: number;
  minSampleForRates: number;
  maxUnknownShare: number;
  maxOrphanShare: number;
  analysisMaturityLagDays: number;
  analysisCadenceHours: number;
  maxDaysPerAnalysis: number;
  mirrorPath: string;
  mirrorStalenessMaxDays: number;
  byModelRetentionDays: number;
  chronicCycles: number;
  maxHistoryPerKey: number;
  maxAggregateRowsPerPeer: number;
  maxNewFindingKeysPerPass: number;
}

function posNum(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
}

/** Resolve the benchmarkDivergence.* config block with the spec defaults. */
export function resolveBenchmarkDivergenceSettings(config: InstarConfig): BenchmarkDivergenceSettings {
  const bd = (config as { benchmarkDivergence?: Record<string, unknown> }).benchmarkDivergence ?? {};
  const quality = config.provenance?.quality ?? {};
  return {
    enabled: resolveDevAgentGate(bd.enabled as boolean | undefined, config),
    dryRun: bd.dryRun !== false, // default TRUE (FD13 — the write-safety canary)
    divergenceThreshold: posNum(bd.divergenceThreshold, 0.15),
    // minSampleForRates falls through to the meter's knob (spec §Config).
    minSampleForRates: posNum(bd.minSampleForRates, posNum(quality.minSampleForRates, 20)),
    maxUnknownShare: posNum(bd.maxUnknownShare, 0.5),
    maxOrphanShare: posNum(bd.maxOrphanShare, 0.1),
    analysisMaturityLagDays: posNum(bd.analysisMaturityLagDays, 2),
    analysisCadenceHours: posNum(bd.analysisCadenceHours, 24),
    maxDaysPerAnalysis: posNum(bd.maxDaysPerAnalysis, 35),
    mirrorPath: typeof bd.mirrorPath === 'string' && bd.mirrorPath ? bd.mirrorPath : 'src/data/benchmarkPredictions.json',
    mirrorStalenessMaxDays: posNum(bd.mirrorStalenessMaxDays, 30),
    byModelRetentionDays: posNum(bd.byModelRetentionDays, 180),
    chronicCycles: posNum(bd.chronicCycles, 3),
    maxHistoryPerKey: posNum(bd.maxHistoryPerKey, 50),
    maxAggregateRowsPerPeer: Math.min(posNum(bd.maxAggregateRowsPerPeer, 10_000), 10_000), // hard absolute cap
    maxNewFindingKeysPerPass: posNum(bd.maxNewFindingKeysPerPass, 200),
  };
}

/* ── Pass results ─────────────────────────────────────────────────────────── */

export interface PoolCollectReport {
  peersQueried: number;
  peersOk: number;
  failed: Array<{ machineId: string; reason: string }>;
  suspect: Array<{ machineId: string; reasons: string[] }>;
}

export interface AnalysisPassResult {
  ran: boolean;
  reason?: 'disabled' | 'not-holder' | 'already-running' | 'rate-limited' | 'lease-lost' | 'ledger-unavailable';
  holderMachineId?: string | null;
  dryRun?: boolean;
  /** Cadence trigger: the pass was scheduled after the FD8 jitter delay. */
  scheduled?: boolean;
  delayMs?: number;
  findingsUpserted?: number;
  wouldUpsert?: number;
  byVerdict?: Record<string, number>;
  window?: { fromDay: string; toDay: string };
  pool?: PoolCollectReport;
  unanalyzedLossAccrued?: number;
}

export interface AnalyzerStatus {
  isHolder: boolean;
  holderMachineId: string | null;
  lastLocalAnalysisAt: string | null;
  /** True on a non-holder plain read (FD10 — never dead data presented as current). */
  stale: boolean;
}

export interface MirrorStatus {
  present: boolean;
  capturedAt: string | null;
  staleDays: number | null;
  stale: boolean;
}

/* ── Analyzer ─────────────────────────────────────────────────────────────── */

export interface BenchmarkDivergenceAnalyzerOptions {
  ledger: FeatureMetricsLedger;
  config: InstarConfig;
  /** This machine's mesh id (meshSelfId); 'local' on a single-machine install. */
  machineId?: string | null;
  /** Serving-lease read (FD8): single-machine (no coordinator) counts as holder. */
  isHolder?: (() => boolean) | null;
  holderMachineId?: (() => string | null) | null;
  /** Every other registered machine with a known URL (the peer fan-out set). */
  resolvePeerUrls?: (() => Array<{ machineId: string; url: string }>) | null;
  /** Peer-URL credential guard (FD9) — the Bearer never travels to a rejected URL. */
  isPeerUrlAllowed?: ((url: string) => boolean) | null;
  authToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected cadence jitter (tests → () => 0). Default uniform(0, fraction×cadence). */
  jitterMs?: ((cadenceMs: number) => number) | null;
  log?: (msg: string) => void;
}

export class BenchmarkDivergenceAnalyzer {
  private readonly ledger: FeatureMetricsLedger;
  private readonly config: InstarConfig;
  private readonly machineId: string;
  private readonly isHolderFn: () => boolean;
  private readonly holderMachineIdFn: () => string | null;
  private readonly resolvePeerUrlsFn: () => Array<{ machineId: string; url: string }>;
  private readonly isPeerUrlAllowedFn: (url: string) => boolean;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly jitterMsFn: (cadenceMs: number) => number;
  private readonly log: (msg: string) => void;

  private inFlight = false;
  private pendingCadenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPassStartedMs: number | null = null;
  private lastPassCompletedMs: number | null = null;

  constructor(opts: BenchmarkDivergenceAnalyzerOptions) {
    this.ledger = opts.ledger;
    this.config = opts.config;
    this.machineId = opts.machineId ?? 'local';
    this.isHolderFn = opts.isHolder ?? (() => true);
    this.holderMachineIdFn = opts.holderMachineId ?? (() => this.machineId);
    this.resolvePeerUrlsFn = opts.resolvePeerUrls ?? (() => []);
    this.isPeerUrlAllowedFn = opts.isPeerUrlAllowed ?? (() => true);
    this.authToken = opts.authToken ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.jitterMsFn = opts.jitterMs ?? ((cadenceMs) => Math.floor(Math.random() * CADENCE_JITTER_FRACTION * cadenceMs));
    this.log = opts.log ?? ((m) => console.log(m));
  }

  settings(): BenchmarkDivergenceSettings {
    return resolveBenchmarkDivergenceSettings(this.config);
  }

  /** FD10 analyzer status block for GET /benchmark-divergence. */
  status(): AnalyzerStatus {
    const isHolder = this.isHolderFn();
    return {
      isHolder,
      holderMachineId: this.holderMachineIdFn(),
      lastLocalAnalysisAt: this.lastPassCompletedMs ? new Date(this.lastPassCompletedMs).toISOString() : null,
      stale: !isHolder,
    };
  }

  /** FD10 mirror status block (staleness derived from the file-level capturedAt). */
  mirrorStatus(): MirrorStatus {
    const s = this.settings();
    const mirror = this.loadMirror(s);
    const staleDays = this.mirrorStaleDays(mirror);
    return {
      present: mirror.present,
      capturedAt: mirror.capturedAt,
      staleDays,
      stale: !mirror.present || (staleDays !== null && staleDays > s.mirrorStalenessMaxDays),
    };
  }

  private loadMirror(s: BenchmarkDivergenceSettings): BenchmarkMirror {
    return loadBenchmarkMirror(resolveMirrorPath(this.config.projectDir, s.mirrorPath));
  }

  private mirrorStaleDays(mirror: BenchmarkMirror): number | null {
    if (!mirror.present || !mirror.capturedAt) return null;
    const ms = Date.parse(mirror.capturedAt);
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.floor((this.now() - ms) / 86_400_000));
  }

  /**
   * Trigger one analysis pass (FD8). `trigger: 'cadence'` (the built-in job)
   * applies the bounded jitter delay; `'manual'` (an explicit operator POST)
   * runs immediately. Both are lease-gated; rate-limited; single-flight.
   */
  async analyze(trigger: 'cadence' | 'manual' = 'manual'): Promise<AnalysisPassResult> {
    const s = this.settings();
    if (!s.enabled) return { ran: false, reason: 'disabled' };
    if (!this.isHolderFn()) {
      return { ran: false, reason: 'not-holder', holderMachineId: this.holderMachineIdFn() };
    }
    if (this.inFlight || this.pendingCadenceTimer) return { ran: false, reason: 'already-running' };
    const nowMs = this.now();
    if (this.lastPassStartedMs !== null && nowMs - this.lastPassStartedMs < ANALYZE_MIN_INTERVAL_MS) {
      return { ran: false, reason: 'rate-limited' };
    }
    if (trigger === 'cadence') {
      const delay = Math.max(0, this.jitterMsFn(s.analysisCadenceHours * 3_600_000));
      if (delay > 0) {
        this.pendingCadenceTimer = setTimeout(() => {
          this.pendingCadenceTimer = null;
          void this.runPass(s).catch(() => {
            /* @silent-fallback-ok: the delayed cadence pass retries on the next cadence tick */
          });
        }, delay);
        this.pendingCadenceTimer.unref?.();
        return { ran: true, dryRun: s.dryRun, scheduled: true, delayMs: delay };
      }
    }
    return this.runPass(s);
  }

  /** Stop any pending delayed cadence pass (server shutdown). */
  stop(): void {
    if (this.pendingCadenceTimer) {
      clearTimeout(this.pendingCadenceTimer);
      this.pendingCadenceTimer = null;
    }
  }

  /* ── The pass ───────────────────────────────────────────────────────────── */

  private async runPass(s: BenchmarkDivergenceSettings): Promise<AnalysisPassResult> {
    if (this.inFlight) return { ran: false, reason: 'already-running' };
    this.inFlight = true;
    this.lastPassStartedMs = this.now();
    try {
      const todayDay = utcDayKey(this.now());
      const toDay = addDays(todayDay, -s.analysisMaturityLagDays);
      const fromDay = addDays(toDay, -(s.maxDaysPerAnalysis - 1));
      const localEdgeDay = addDays(todayDay, -s.byModelRetentionDays);

      // FD7 loss accounting (pure R1 — never gates anything): accrue days that
      // aged past the by_model retention having never been covered by a pass,
      // then hygiene-prune stale watermark rows. Skipped entirely in dryRun
      // (FD13: zero detector-owned durable writes).
      let lossAccrued = 0;
      if (!s.dryRun) {
        lossAccrued = this.ledger.accrueBenchmarkWatermarkLoss(this.machineId, localEdgeDay);
        this.ledger.pruneBenchmarkWatermarks(s.byModelRetentionDays);
      }

      // Local aggregates (one grouped indexed query — never O(raw), FD12).
      const localRows = this.ledger.byModelAggregates(fromDay, toDay);
      const localOrphans = this.ledger.orphanAggregates(fromDay, toDay);

      // R2 pool-collect: bounded, parallel, peer-URL-guarded, ONE deadline.
      const collect = await this.collectPeers(s, fromDay, toDay, todayDay);

      // Pool-merge (FD9): local + admitted peer rows.
      const machinesKnown = 1 + collect.peers.length;
      const machinesReporting = 1 + collect.report.peersOk;
      const coverageComplete = machinesReporting === machinesKnown;

      // analysisWindow = INTERSECTION of days actually covered by all
      // reporting machines (FD8): each machine covers [max(fromDay, its
      // retention edge), toDay].
      let windowFromDay = fromDay;
      const edges: Array<string | null> = [localEdgeDay, ...collect.envelopes.map((e) => e.retentionEdgeDay)];
      for (const edge of edges) {
        if (edge && edge > windowFromDay) windowFromDay = edge;
      }
      const analysisWindow = { fromDay: windowFromDay, toDay };

      type MergedBucket = {
        rightN: number;
        wrongN: number;
        unknownN: number;
        decidedTotal: number;
        promptIds: Set<string>;
        byMachine: Map<string, number>; // decidedTotal contribution per machine
      };
      // Keyed (decisionPointId, model) over the intersected window.
      const merged = new Map<string, MergedBucket>();
      const orphansByPoint = new Map<string, number>();
      const decidedByPoint = new Map<string, number>();
      const missingByPoint = new Map<string, number>();

      const fold = (machineId: string, rows: AggregateBucketRow[], orphanRows: OrphanCountRow[]): void => {
        for (const r of rows) {
          if (r.day < analysisWindow.fromDay || r.day > analysisWindow.toDay) continue;
          decidedByPoint.set(r.decisionPointId, (decidedByPoint.get(r.decisionPointId) ?? 0) + r.decidedTotal);
          if (r.model === MODEL_MISSING) {
            // Excluded from comparisons; surfaced as missingModelShare (§Durable schema).
            missingByPoint.set(r.decisionPointId, (missingByPoint.get(r.decisionPointId) ?? 0) + r.decidedTotal);
            continue;
          }
          const key = `${r.decisionPointId} ${r.model}`;
          const b = merged.get(key) ?? {
            rightN: 0, wrongN: 0, unknownN: 0, decidedTotal: 0,
            promptIds: new Set<string>(), byMachine: new Map<string, number>(),
          };
          b.rightN += r.rightN;
          b.wrongN += r.wrongN;
          b.unknownN += r.unknownN;
          b.decidedTotal += r.decidedTotal;
          if (r.promptId !== '') b.promptIds.add(r.promptId);
          b.byMachine.set(machineId, (b.byMachine.get(machineId) ?? 0) + r.decidedTotal);
          merged.set(key, b);
        }
        for (const o of orphanRows) {
          if (o.day < analysisWindow.fromDay || o.day > analysisWindow.toDay) continue;
          orphansByPoint.set(o.decisionPointId, (orphansByPoint.get(o.decisionPointId) ?? 0) + o.orphanOutcomes);
        }
      };
      fold(this.machineId, localRows, localOrphans);
      for (const env of collect.envelopes) fold(env.machineId, env.rows, env.orphanRows);

      // The mirror (FD1) + live hashes (FD6).
      const mirror = this.loadMirror(s);
      const mirrorStaleDays = this.mirrorStaleDays(mirror);

      // Chronic seed (FD8): the pool-merged latest view — local findings +
      // peers' clamped finding rows — so lease churn cannot reset a streak.
      const localFindings = this.readLocalFindingViews(todayDay, s);
      const seedView = mergeFindingsByKey([...localFindings, ...collect.peerFindings]);
      const seedStreaks = new Map<string, number>();
      for (const f of seedView) seedStreaks.set(`${f.taskId} ${f.decisionPointId} ${f.model}`, f.chronicStreak);
      const existingKeys = new Set(localFindings.map((f) => `${f.taskId} ${f.decisionPointId} ${f.model}`));

      // Enumerate findings per enrolled pair × observed model (FD2).
      const computed: Array<{
        taskId: string;
        decisionPointId: string;
        model: string;
        verdict: DivergenceVerdict;
        preconditionReason?: PreconditionReason;
        unmapped?: boolean;
        orphanTainted: boolean;
        realGradeRate: number | null;
        predictedRate: number | null;
        delta: number | null;
        gradedN: number;
        unknownShare: number | null;
        ciHalfWidth: number | null;
        benchN: number | null;
        benchCiHalfWidth: number | null;
        chronicStreak: number;
        chronic: boolean;
        chronicReason: string | null;
        byMachine: Record<string, number>;
        dominantMachineShare: number | null;
      }> = [];

      for (const [decisionPointId, taskId] of Object.entries(ENROLLED_PAIRS)) {
        const decided = decidedByPoint.get(decisionPointId) ?? 0;
        const orphanShare = decided > 0 ? (orphansByPoint.get(decisionPointId) ?? 0) / decided : 0;
        const registryEntry = PROMPT_TEMPLATE_REGISTRY[taskId];
        const liveHash = liveTemplateHash(taskId);
        const task = mirror.tasks[taskId];
        const registrySourceMatches =
          !!registryEntry && typeof task?.benchedPromptSource === 'string' && task.benchedPromptSource === registryEntry.source;

        for (const [key, bucket] of merged) {
          const [dp, model] = key.split(' ');
          if (dp !== decisionPointId) continue;
          const normalizedModel = normalizeModelId(model);
          const bench = normalizedModel !== null ? task?.perModel[normalizedModel] ?? null : null;
          const v = computeVerdict({
            normalizedModel,
            mirrorPresent: mirror.present,
            mirrorStaleDays,
            mirrorStalenessMaxDays: s.mirrorStalenessMaxDays,
            bench,
            benchedPromptHash: task?.benchedPromptHash ?? null,
            liveHash,
            registrySourceMatches,
            windowPromptIds: Array.from(bucket.promptIds),
            rightN: bucket.rightN,
            wrongN: bucket.wrongN,
            decidedTotal: bucket.decidedTotal,
            orphanShare,
            coverageComplete,
            thresholds: {
              divergenceThreshold: s.divergenceThreshold,
              minSample: s.minSampleForRates,
              maxUnknownShare: s.maxUnknownShare,
              maxOrphanShare: s.maxOrphanShare,
            },
          });

          const seed = seedStreaks.get(`${taskId} ${decisionPointId} ${model}`) ?? 0;
          const streak = nextChronicStreak(seed, v.verdict);
          const chronic = streak >= s.chronicCycles;
          const chronicReason = chronic ? this.chronicReasonFor(v.verdict, v.preconditionReason, coverageComplete) : null;

          let dominant: number | null = null;
          if (bucket.decidedTotal > 0) {
            let max = 0;
            for (const n of bucket.byMachine.values()) if (n > max) max = n;
            dominant = max / bucket.decidedTotal;
          }

          computed.push({
            taskId,
            decisionPointId,
            model,
            verdict: v.verdict,
            ...(v.preconditionReason !== undefined ? { preconditionReason: v.preconditionReason } : {}),
            ...(v.unmapped !== undefined ? { unmapped: v.unmapped } : {}),
            orphanTainted: v.orphanTainted,
            realGradeRate: v.realGradeRate,
            predictedRate: v.predictedRate,
            delta: v.delta,
            gradedN: v.gradedN,
            unknownShare: v.unknownShare,
            ciHalfWidth: v.ciHalfWidth,
            benchN: v.benchN,
            benchCiHalfWidth: v.benchCiHalfWidth,
            chronicStreak: streak,
            chronic,
            chronicReason,
            byMachine: Object.fromEntries(bucket.byMachine),
            dominantMachineShare: dominant,
          });
        }
      }

      // FD9 unmapped-flood ceiling: keys NEW this pass beyond the cap collapse
      // into ONE deduped flood finding — never a wall of new rows.
      const newKeys = computed.filter((c) => !existingKeys.has(`${c.taskId} ${c.decisionPointId} ${c.model}`));
      let floodCollapsed = 0;
      let toWrite = computed;
      if (newKeys.length > s.maxNewFindingKeysPerPass) {
        const admitNew = new Set(
          newKeys
            .slice()
            .sort((a, b) => (a.taskId + a.decisionPointId + a.model < b.taskId + b.decisionPointId + b.model ? -1 : 1))
            .slice(0, s.maxNewFindingKeysPerPass)
            .map((c) => `${c.taskId} ${c.decisionPointId} ${c.model}`),
        );
        toWrite = computed.filter((c) => {
          const k = `${c.taskId} ${c.decisionPointId} ${c.model}`;
          const keep = existingKeys.has(k) || admitNew.has(k);
          if (!keep) floodCollapsed++;
          return keep;
        });
        toWrite.push({
          taskId: 'unmapped-flood',
          decisionPointId: 'unmapped-flood',
          model: UNMAPPED_FLOOD_MODEL,
          verdict: 'no-benched-baseline',
          unmapped: true,
          orphanTainted: false,
          realGradeRate: null,
          predictedRate: null,
          delta: null,
          gradedN: floodCollapsed, // content-free: the collapsed-key COUNT
          unknownShare: null,
          ciHalfWidth: null,
          benchN: null,
          benchCiHalfWidth: null,
          chronicStreak: 0,
          chronic: false,
          chronicReason: null,
          byMachine: {},
          dominantMachineShare: null,
        });
      }

      const byVerdict: Record<string, number> = {};
      for (const c of toWrite) byVerdict[c.verdict] = (byVerdict[c.verdict] ?? 0) + 1;

      if (s.dryRun) {
        // FD13: zero detector-owned durable writes — content-free would-analyze summary.
        this.lastPassCompletedMs = this.now();
        this.log(
          `[benchmark-divergence] dryRun pass: window ${analysisWindow.fromDay}..${analysisWindow.toDay}, ` +
            `wouldUpsert=${toWrite.length}, byVerdict=${JSON.stringify(byVerdict)}, ` +
            `pool ok=${collect.report.peersOk}/${collect.report.peersQueried}`,
        );
        return {
          ran: true,
          dryRun: true,
          wouldUpsert: toWrite.length,
          byVerdict,
          window: analysisWindow,
          pool: collect.report,
          unanalyzedLossAccrued: 0,
        };
      }

      // FD8: the lease is re-checked ONCE before the findings upsert to bound
      // a mid-pass flap — a lost lease aborts the write, never a partial one.
      if (!this.isHolderFn()) {
        return { ran: false, reason: 'lease-lost', holderMachineId: this.holderMachineIdFn() };
      }

      const coverage = {
        machinesReporting,
        machinesKnown,
        byMachine: {} as Record<string, number>,
      };
      let upserted = 0;
      for (const c of toWrite) {
        this.ledger.upsertBenchmarkFinding({
          taskId: c.taskId,
          decisionPointId: c.decisionPointId,
          model: c.model,
          verdict: c.verdict,
          preconditionReason: c.preconditionReason ?? null,
          realGradeRate: c.realGradeRate,
          predictedRate: c.predictedRate,
          delta: c.delta,
          gradedN: c.gradedN,
          unknownShare: c.unknownShare,
          ciHalfWidth: c.ciHalfWidth,
          benchN: c.benchN,
          benchCiHalfWidth: c.benchCiHalfWidth,
          orphanTainted: c.orphanTainted,
          chronic: c.chronic,
          chronicStreak: c.chronicStreak,
          chronicReason: c.chronicReason,
          coverageJson: JSON.stringify({ ...coverage, byMachine: c.byMachine }),
          dominantMachineShare: c.dominantMachineShare,
          unmapped: c.unmapped ?? null,
          benchedPromptHash: mirror.tasks[c.taskId]?.benchedPromptHash ?? null,
          mirrorCapturedAt: mirror.capturedAt,
          windowFromDay: analysisWindow.fromDay,
          windowToDay: analysisWindow.toDay,
          maxHistoryPerKey: s.maxHistoryPerKey,
        });
        upserted++;
      }

      // FD7: advance this machine's watermarks over the pairs its LOCAL data
      // covered (pure loss accounting — duplicates never skips on churn; the
      // first-seen seed prevents the false-loss drip).
      const seedDay = addDays(todayDay, -s.maxDaysPerAnalysis);
      const localPairs = new Set<string>();
      for (const r of localRows) localPairs.add(`${r.decisionPointId} ${r.model}`);
      for (const key of localPairs) {
        const [dp, model] = key.split(' ');
        this.ledger.advanceBenchmarkWatermark(this.machineId, dp, model, toDay, seedDay);
      }

      this.lastPassCompletedMs = this.now();
      return {
        ran: true,
        dryRun: false,
        findingsUpserted: upserted,
        byVerdict,
        window: analysisWindow,
        pool: collect.report,
        unanalyzedLossAccrued: lossAccrued,
      };
    } finally {
      this.inFlight = false;
    }
  }

  private chronicReasonFor(
    verdict: DivergenceVerdict,
    preconditionReason: PreconditionReason | undefined,
    coverageComplete: boolean,
  ): string {
    if (verdict === 'partial' && !coverageComplete) return 'machine-persistently-offline';
    if (verdict === 'insufficient-evidence') return 'graded-n-stuck';
    if (verdict === 'precondition-failed' && preconditionReason === 'stale-mirror') return 'mirror-stale';
    return 'precondition-persistent';
  }

  /* ── Peer collection (FD8/FD9) ─────────────────────────────────────────── */

  private async collectPeers(
    s: BenchmarkDivergenceSettings,
    fromDay: string,
    toDay: string,
    todayDay: string,
  ): Promise<{
    peers: Array<{ machineId: string; url: string }>;
    envelopes: Array<{ machineId: string; retentionEdgeDay: string | null; rows: AggregateBucketRow[]; orphanRows: OrphanCountRow[] }>;
    peerFindings: FindingView[];
    report: PoolCollectReport;
  }> {
    const peers = this.resolvePeerUrlsFn().slice(0, MAX_PEERS_PER_COLLECT);
    const report: PoolCollectReport = { peersQueried: peers.length, peersOk: 0, failed: [], suspect: [] };
    const envelopes: Array<{ machineId: string; retentionEdgeDay: string | null; rows: AggregateBucketRow[]; orphanRows: OrphanCountRow[] }> = [];
    const peerFindings: FindingView[] = [];
    if (peers.length === 0) return { peers, envelopes, peerFindings, report };

    // ONE deadline for the whole fan-out (FD8).
    const signal = AbortSignal.timeout(POOL_COLLECT_DEADLINE_MS);
    const maxAgeDays = s.byModelRetentionDays;
    await Promise.all(
      peers.map(async (p) => {
        if (!this.isPeerUrlAllowedFn(p.url)) {
          report.failed.push({ machineId: p.machineId, reason: 'url-rejected' });
          return;
        }
        try {
          const r = await this.fetchImpl(
            `${p.url}/benchmark-divergence/rollup-aggregates?fromDay=${fromDay}&toDay=${toDay}`,
            { headers: { Authorization: `Bearer ${this.authToken}` }, signal },
          );
          if (!r.ok) {
            report.failed.push({ machineId: p.machineId, reason: `http-${r.status}` });
            return;
          }
          const raw = (await r.json()) as unknown;
          const clamped = clampPeerAggregates(raw, {
            machineId: p.machineId,
            todayDay,
            maxAgeDays,
            maxRows: s.maxAggregateRowsPerPeer,
          });
          if (clamped.suspectReasons.length > 0) {
            report.suspect.push({ machineId: p.machineId, reasons: clamped.suspectReasons });
          }
          envelopes.push(clamped.envelope);
          report.peersOk++;

          // Chronic-seed collection (FD8): the peer's latest finding view,
          // through the SAME FD9 allowlist (free text never crosses).
          try {
            const fr = await this.fetchImpl(`${p.url}/benchmark-divergence`, {
              headers: { Authorization: `Bearer ${this.authToken}` },
              signal,
            });
            if (fr.ok) {
              const fj = (await fr.json()) as { findings?: unknown[] };
              for (const rawF of (fj.findings ?? []).slice(0, 500)) {
                const f = clampPeerFinding(rawF, { todayDay, maxAgeDays });
                if (f) peerFindings.push(f);
              }
            }
          } catch {
            // @silent-fallback-ok: a missing finding-seed degrades to the local
            // streak view — the aggregates (the load-bearing data) landed above.
          }
        } catch (err) {
          report.failed.push({
            machineId: p.machineId,
            reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable',
          });
        }
      }),
    );
    return { peers, envelopes, peerFindings, report };
  }

  /* ── Read surfaces (FD10) ──────────────────────────────────────────────── */

  /** The local findings latest view as FD10 FindingViews (questions regenerated). */
  readLocalFindingViews(todayDay?: string, settings?: BenchmarkDivergenceSettings): FindingView[] {
    const s = settings ?? this.settings();
    const today = todayDay ?? utcDayKey(this.now());
    const out: FindingView[] = [];
    for (const row of this.ledger.listBenchmarkFindings()) {
      const view = clampPeerFinding(this.rowToRaw(row), { todayDay: today, maxAgeDays: s.byModelRetentionDays });
      if (view) out.push(view);
    }
    return out;
  }

  /** Map a findings-table row into the raw FD10 shape clampPeerFinding admits. */
  private rowToRaw(row: Record<string, unknown>): Record<string, unknown> {
    let coverage: unknown = { machinesReporting: 0, machinesKnown: 0, byMachine: {} };
    if (typeof row.coverageJson === 'string') {
      try {
        coverage = JSON.parse(row.coverageJson);
      } catch {
        // @silent-fallback-ok: a corrupt coverage blob degrades to the empty shape.
      }
    }
    return {
      taskId: row.taskId,
      decisionPointId: row.decisionPointId,
      model: row.model,
      verdict: row.verdict,
      preconditionReason: row.preconditionReason ?? undefined,
      realGradeRate: row.realGradeRate,
      predictedRate: row.predictedRate,
      delta: row.delta,
      gradedN: row.gradedN,
      unknownShare: row.unknownShare,
      ciHalfWidth: row.ciHalfWidth,
      benchN: row.benchN,
      benchCiHalfWidth: row.benchCiHalfWidth,
      orphanTainted: row.orphanTainted === 1 || row.orphanTainted === true,
      chronic: row.chronic === 1 || row.chronic === true,
      chronicStreak: row.chronicStreak,
      chronicReason: row.chronicReason ?? undefined,
      coverage,
      dominantMachineShare: row.dominantMachineShare,
      unmapped: row.unmapped === 1 ? true : row.unmapped === 0 ? false : undefined,
      benchedPromptHash: row.benchedPromptHash,
      mirrorCapturedAt: row.mirrorCapturedAt,
      analysisWindow: { fromDay: row.windowFromDay, toDay: row.windowToDay },
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    };
  }

  /** FD10 summary block: byVerdict + unmapped models + missingModelShare +
   *  per-machine unanalyzed loss. Read-time, bounded, indexed. */
  summary(): {
    byVerdict: Record<string, number>;
    unmappedModels: string[];
    missingModelShare: number;
    unanalyzedLoss: { byMachine: Record<string, number> };
  } {
    const s = this.settings();
    const findings = this.ledger.listBenchmarkFindings();
    const byVerdict: Record<string, number> = {};
    const unmapped = new Set<string>();
    for (const f of findings) {
      const v = String(f.verdict);
      byVerdict[v] = (byVerdict[v] ?? 0) + 1;
      if (f.unmapped === 1 && typeof f.model === 'string' && f.model !== UNMAPPED_FLOOD_MODEL) unmapped.add(f.model);
    }
    // missingModelShare over the CURRENT matured window (the '__missing__'
    // share of all recorded decisions — excluded from comparisons, surfaced).
    const todayDay = utcDayKey(this.now());
    const toDay = addDays(todayDay, -s.analysisMaturityLagDays);
    const fromDay = addDays(toDay, -(s.maxDaysPerAnalysis - 1));
    let missing = 0;
    let total = 0;
    for (const r of this.ledger.byModelAggregates(fromDay, toDay)) {
      total += r.decidedTotal;
      if (r.model === MODEL_MISSING) missing += r.decidedTotal;
    }
    const byMachine: Record<string, number> = {};
    for (const w of this.ledger.listBenchmarkWatermarks()) {
      if (w.unanalyzedLoss > 0) byMachine[w.machineId] = (byMachine[w.machineId] ?? 0) + w.unanalyzedLoss;
    }
    return {
      byVerdict,
      unmappedModels: Array.from(unmapped).sort(),
      missingModelShare: total > 0 ? missing / total : 0,
      unanalyzedLoss: { byMachine },
    };
  }

  /** The peer-collection route body (FD10): this machine's matured-window
   *  aggregates; the SERVING peer clamps the range (maxDaysPerAnalysis +
   *  retention) and bounds the row count. */
  rollupAggregates(fromDayRaw: string, toDayRaw: string): {
    machineId: string;
    retentionEdgeDay: string;
    rows: AggregateBucketRow[];
    orphanRows: OrphanCountRow[];
    truncated: boolean;
  } {
    const s = this.settings();
    const todayDay = utcDayKey(this.now());
    const edge = addDays(todayDay, -s.byModelRetentionDays);
    let toDay = toDayRaw > todayDay ? todayDay : toDayRaw;
    let fromDay = fromDayRaw;
    // Clamp: min(requested, own maxDaysPerAnalysis, own retention).
    const minFrom = addDays(toDay, -(s.maxDaysPerAnalysis - 1));
    if (fromDay < minFrom) fromDay = minFrom;
    if (fromDay < edge) fromDay = edge;
    if (toDay < fromDay) toDay = fromDay;
    const all = this.ledger.byModelAggregates(fromDay, toDay);
    const truncated = all.length > s.maxAggregateRowsPerPeer;
    const rows = truncated ? all.slice(0, s.maxAggregateRowsPerPeer) : all;
    const orphanAll = this.ledger.orphanAggregates(fromDay, toDay);
    const orphanRows = orphanAll.length > s.maxAggregateRowsPerPeer ? orphanAll.slice(0, s.maxAggregateRowsPerPeer) : orphanAll;
    return { machineId: this.machineId, retentionEdgeDay: edge, rows, orphanRows, truncated };
  }
}

/** Exported for the mirror-path unit tests. */
export function benchmarkMirrorAbsolutePath(config: InstarConfig): string {
  const s = resolveBenchmarkDivergenceSettings(config);
  return resolveMirrorPath(config.projectDir, s.mirrorPath);
}

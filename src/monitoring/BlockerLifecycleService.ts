import type { CommitmentTracker, BlockerEpisode, Commitment } from './CommitmentTracker.js';
import crypto from 'node:crypto';
import type { Initiative, MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import type { InitiativeTracker } from '../core/InitiativeTracker.js';
import { BlockerLifecycleLedger, percentile, type BlockerFactor, type BlockerMetricRecord, type MaturationEvaluationRecord, type MaturationEvaluationStatus } from './BlockerLifecycleLedger.js';
import { DegradationReporter } from './DegradationReporter.js';

type FailureReason = 'insufficient-days' | 'insufficient-samples' | 'zero-denominator';

export class BlockerLifecycleService {
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maturationTimer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private breakerUntil = 0;
  private closed = false;
  private maturationInitiatives: Initiative[] = [];
  private maturationAccountingInitiatives: Initiative[] = [];
  private readonly maturationProjections = new Map<string, () => { value: number; samples: number } | null>();
  private readonly onRequest = (event: Record<string, unknown>): void => {
    this.ledger.enqueue({
      origin: this.origin,
      factor: 'request-to-persist',
      sourceEventId: String(event.sourceEventId),
      observedAtMs: Number(event.observedAtMs),
      latencyMs: Number(event.latencyMs),
      outcome: 'observed',
    });
  };
  private readonly onClose = (event: { commitmentId: string; episode: BlockerEpisode }): void => {
    const record = this.clearRecord(event.episode);
    this.ledger.enqueue(record);
    // The async queue owns first delivery. Reconciliation will mark completion
    // after observing the row, so a process crash cannot create a false receipt.
  };
  private readonly onDelivered = (commitment: Commitment): void => {
    const record = this.completionRecord(commitment);
    if (record) this.ledger.enqueue(record);
  };

  constructor(
    private readonly tracker: CommitmentTracker,
    readonly ledger: BlockerLifecycleLedger,
    private readonly origin: string,
    private readonly now: () => number = () => Date.now(),
    initiativeTracker?: Pick<InitiativeTracker, 'list'>,
  ) {
    tracker.on('blocker-request-persisted', this.onRequest);
    tracker.on('blocker-episode-closed', this.onClose);
    tracker.on('delivered', this.onDelivered);
    this.registerMaturationProjection('blocker-lifecycle.completed-transitions', () => {
      const since = this.now() - 168 * 3_600_000;
      const samples = (['request-to-persist', 'clear-latency', 'deliverable-completion'] as const)
        .reduce((total, factor) => total + this.ledger.values(factor, since).filter(row => row.outcome === 'observed').length, 0);
      return { value: samples, samples };
    });
    this.schedule(5_000);
    if (initiativeTracker) {
      const evaluate = () => { try { this.evaluateMaturation(initiativeTracker.list()); } catch { /* @silent-fallback-ok — the absent durable slot is surfaced as missed cadence on the next successful pass */ } };
      setTimeout(evaluate, 10_000).unref?.();
      this.maturationTimer = setInterval(evaluate, 6 * 60 * 60 * 1000);
      this.maturationTimer.unref?.();
    }
  }

  available(): boolean { return this.ledger.available(); }

  /** Register a read-only projection from an existing feature's counters onto
   * D7. This adds no state owner: the feature remains authoritative and D7
   * snapshots only the bounded numeric pair at evaluation time. */
  registerMaturationProjection(sourceRef: string, read: () => { value: number; samples: number } | null): void {
    this.maturationProjections.set(sourceRef, read);
  }

  localSummary(sinceHours: number): Record<string, unknown> {
    const sinceMs = this.now() - sinceHours * 3_600_000;
    return {
      machineId: this.origin,
      factors: (['request-to-persist', 'clear-latency'] as const).map(f => this.factorSummary(f, sinceMs))
        .concat(this.completionSummary(sinceMs, sinceHours)),
      maturation: this.maturationSummary(sinceMs),
      counters: { ...this.ledger.counters(), ...this.derivedCounters(sinceMs), breakerOpen: this.now() < this.breakerUntil },
    };
  }

  localTrend(windowDays: number): Record<string, unknown> {
    const sinceMs = this.now() - windowDays * 86_400_000;
    return {
      machineId: this.origin,
      factors: (['request-to-persist', 'clear-latency'] as const).map(f => this.factorTrend(f, sinceMs))
        .concat(this.completionTrend(sinceMs, windowDays)),
      maturation: this.maturationTrend(sinceMs),
    };
  }

  /** D7 recurring scorer. Called only by the existing rollout reconciler cadence. */
  evaluateMaturation(initiatives: Initiative[]): { eligible: number; inserted: number } {
    const now = this.now();
    const accounted = initiatives.filter(i => i.rolloutAccounting)
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 512);
    const eligible = initiatives.filter(i => {
      if (i.rolloutAccounting) return i.rolloutAccounting.disposition !== 'excluded';
      return Boolean(i.rollout && i.rollout.stage !== 'default-on');
    })
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 512);
    this.maturationAccountingInitiatives = accounted.map(i => ({ ...i, rolloutAccounting: i.rolloutAccounting ? { ...i.rolloutAccounting } : undefined }));
    this.maturationInitiatives = eligible.map(i => ({ ...i, rollout: i.rollout ? { ...i.rollout } : undefined,
      rolloutAccounting: i.rolloutAccounting ? { ...i.rolloutAccounting } : undefined }));
    let inserted = 0;
    for (const initiative of eligible) {
      const contract = initiative.rolloutAccounting?.maturationEvaluation ?? initiative.rollout?.maturationEvaluation;
      const rung = initiative.rolloutAccounting ? initiative.rolloutAccounting.rung : initiative.rollout?.stage ?? null;
      const cadenceHours = contract?.cadenceHours ?? 6;
      const cadenceMs = cadenceHours * 3_600_000;
      const dueSlotMs = Math.floor(now / cadenceMs) * cadenceMs;
      const previous = this.ledger.maturationEvaluations(this.origin, now - 90 * 86_400_000)
        .filter(r => r.featureId === initiative.id).sort((a, b) => b.dueSlotMs - a.dueSlotMs)[0];
      if (previous && previous.dueSlotMs < dueSlotMs - cadenceMs) {
        const missed = Math.floor((dueSlotMs - previous.dueSlotMs) / cadenceMs) - 1;
        const explicit = Math.min(4, missed);
        for (let n = explicit; n >= 1; n--) {
          const slot = dueSlotMs - n * cadenceMs;
          if (this.ledger.recordMaturationEvaluation({ origin: this.origin, featureId: initiative.id,
            rung, dueSlotMs: slot, evaluatedAtMs: now, status: 'missed-cadence',
            passingMetrics: 0, totalMetrics: contract?.metrics.length ?? 0, minNormalizedMargin: null,
            contractHash: this.contractHash(contract), newestEvidenceAtMs: null,
            additionalMissedSlots: n === explicit ? Math.max(0, missed - explicit) : 0 })) inserted++;
        }
      }
      if (!contract) {
        if (this.ledger.recordMaturationEvaluation({ origin: this.origin, featureId: initiative.id,
          rung, dueSlotMs, evaluatedAtMs: now, status: initiative.rolloutAccounting?.maturationContractError ? 'invalid-contract' : 'missing-contract',
          passingMetrics: 0, totalMetrics: 0, minNormalizedMargin: null,
          contractHash: initiative.rolloutAccounting?.maturationContractError ?? 'missing', newestEvidenceAtMs: null })) inserted++;
        continue;
      }
      this.captureBlockerObservations(initiative.id, contract, now);
      const observations = this.ledger.maturationObservations(this.origin, now - contract.evidenceMaxAgeHours * 3_600_000);
      const latest = new Map<string, (typeof observations)[number]>();
      for (const row of observations) if (row.featureId === initiative.id && !latest.has(row.metricId)) latest.set(row.metricId, row);
      let status: MaturationEvaluationStatus = 'ready';
      let passing = 0; let newest: number | null = null; const margins: number[] = [];
      for (const metric of contract.metrics) {
        const row = latest.get(metric.id);
        if (!row || row.samples < metric.minSamples) { status = 'insufficient-evidence'; continue; }
        newest = Math.max(newest ?? 0, row.observedAtMs);
        if (now - row.observedAtMs > contract.evidenceMaxAgeHours * 3_600_000) { if (status === 'ready') status = 'stale-evidence'; continue; }
        const margin = metric.direction === 'at-least'
          ? (row.value - metric.threshold) / Math.max(Math.abs(metric.threshold), 1)
          : (metric.threshold - row.value) / Math.max(Math.abs(metric.threshold), 1);
        margins.push(Math.max(-1, Math.min(1, margin)));
        if (margin >= 0) passing++; else if (status === 'ready') status = 'hold';
      }
      if (status === 'ready' && passing < contract.metrics.length) status = 'insufficient-evidence';
      if (this.ledger.recordMaturationEvaluation({ origin: this.origin, featureId: initiative.id,
        rung, dueSlotMs, evaluatedAtMs: now, status, passingMetrics: passing,
        totalMetrics: contract.metrics.length, minNormalizedMargin: margins.length ? Math.min(...margins) : null,
        contractHash: this.contractHash(contract), newestEvidenceAtMs: newest })) inserted++;
    }
    return { eligible: eligible.length, inserted };
  }

  private contractHash(contract: MaturationEvaluationContract | undefined): string {
    if (!contract) return 'missing';
    return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  }

  private captureBlockerObservations(featureId: string, contract: MaturationEvaluationContract, now: number): void {
    const summaries = new Map<BlockerFactor, Record<string, unknown>>([
      ...(['request-to-persist', 'clear-latency'] as const).map(f => [f, this.factorSummary(f, now - 168 * 3_600_000)] as const),
      ['deliverable-completion', this.completionSummary(now - 168 * 3_600_000, 168)],
    ]);
    const trends = new Map<BlockerFactor, Record<string, unknown>>([
      ...(['request-to-persist', 'clear-latency'] as const).map(f => [f, this.factorTrend(f, now - 90 * 86_400_000)] as const),
      ['deliverable-completion', this.completionTrend(now - 90 * 86_400_000, 90)],
    ]);
    for (const metric of contract.metrics) {
      if (metric.source === 'feature-summary') {
        let projected: { value: number; samples: number } | null = null;
        try {
          projected = this.maturationProjections.get(metric.sourceRef)?.() ?? null;
        } catch (error) {
          DegradationReporter.getInstance().report({
            feature: 'blocker-lifecycle.maturation-projection',
            primary: `capture ${metric.sourceRef} owner evidence`,
            fallback: 'leave the observation absent so maturation remains HOLD',
            reason: error instanceof Error ? error.message : 'projection callback threw',
            impact: `${featureId} cannot mature until a later projection succeeds`,
          });
          projected = null;
        }
        if (projected && Number.isFinite(projected.value) && Number.isInteger(projected.samples) && projected.samples >= 0) {
          this.ledger.recordMaturationObservation({ origin: this.origin, featureId, metricId: metric.id,
            source: metric.source, sourceRef: metric.sourceRef, observedAtMs: now,
            value: projected.value, samples: projected.samples });
        }
        continue;
      }
      const [factor, field] = metric.sourceRef.split('.') as [BlockerFactor, string];
      const source = metric.source === 'blocker-summary' ? summaries.get(factor) : trends.get(factor);
      const value = source?.[field === 'p95Ms' ? 'p95Ms' : field] as number | null | undefined;
      const samples = metric.source === 'blocker-summary' ? Number(source?.completed ?? 0)
        : Number((source?.secondHalf as { samples?: number; total?: number } | undefined)?.samples ??
          (source?.secondHalf as { total?: number } | undefined)?.total ?? 0);
      if (typeof value === 'number' && Number.isFinite(value)) this.ledger.recordMaturationObservation({
        origin: this.origin, featureId, metricId: metric.id, source: metric.source,
        sourceRef: metric.sourceRef, observedAtMs: now, value, samples,
      });
    }
  }

  private maturationSummary(sinceMs: number): Record<string, unknown> {
    const rows = this.ledger.maturationEvaluations(this.origin, sinceMs);
    const latest = new Map<string, MaturationEvaluationRecord>();
    for (const row of rows) latest.set(row.featureId, row);
    const byStatus: Record<MaturationEvaluationStatus, number> = { ready: 0, hold: 0, 'stale-evidence': 0,
      'insufficient-evidence': 0, 'missing-contract': 0, 'invalid-contract': 0, 'missed-cadence': 0 };
    for (const row of rows) byStatus[row.status]++;
    const features = [...latest.values()].sort((a, b) => a.featureId.localeCompare(b.featureId)).map(r => ({
      featureId: r.featureId, rung: r.rung, status: r.status, evaluatedAt: new Date(r.evaluatedAtMs).toISOString(),
      passingMetrics: r.passingMetrics, totalMetrics: r.totalMetrics,
      minNormalizedMargin: r.minNormalizedMargin, newestEvidenceAt: r.newestEvidenceAtMs ? new Date(r.newestEvidenceAtMs).toISOString() : null,
    }));
    const accounting = this.maturationAccountingInitiatives.map(i => ({
      featureId: i.id, disposition: i.rolloutAccounting!.disposition,
      status: i.status, flagPath: i.rollout?.flagPath ?? null,
      promotionAuthority: i.rolloutAccounting!.disposition === 'active' ? 'self-owner'
        : i.rolloutAccounting!.disposition === 'composed' ? 'parent-owner-evidence-only' : 'none',
      sourcePrNumber: i.rolloutAccounting!.sourcePrNumber, ownerFeatureId: i.rolloutAccounting!.ownerFeatureId ?? null,
      rung: i.rolloutAccounting!.rung, graduationCriterion: i.rolloutAccounting!.graduationCriterion ?? null,
      evidenceSource: i.rolloutAccounting!.evidenceSource ?? null,
      contractError: i.rolloutAccounting!.maturationContractError ?? null,
      metricCount: i.rolloutAccounting!.maturationEvaluation?.metrics.length ?? 0,
      metricDescriptors: (i.rolloutAccounting!.maturationEvaluation?.metrics ?? []).map(metric => ({
        id: metric.id, source: metric.source, sourceRef: metric.sourceRef, descriptorVersion: 1,
        direction: metric.direction, threshold: metric.threshold, minSamples: metric.minSamples,
      })),
    }));
    const accountingCounts = { active: 0, composed: 0, excluded: 0 };
    for (const row of accounting) accountingCounts[row.disposition]++;
    const eligibleCount = this.maturationInitiatives.length;
    const legacyEligible = Math.max(0, eligibleCount - accountingCounts.active - accountingCounts.composed);
    return { eligible: eligibleCount, evaluated: latest.size,
      missedDue: Math.max(0, eligibleCount - latest.size), byStatus, features, accountingCounts, legacyEligible, accounting };
  }

  private maturationTrend(sinceMs: number): Record<string, unknown> {
    const rows = this.ledger.maturationEvaluations(this.origin, sinceMs);
    const grouped = new Map<string, MaturationEvaluationRecord[]>();
    for (const row of rows) { const values = grouped.get(row.featureId) ?? []; values.push(row); grouped.set(row.featureId, values); }
    return { features: [...grouped.entries()].slice(0, 512).map(([featureId, values]) => ({ featureId,
      evaluations: values.slice(-90).map(v => ({ day: new Date(v.dueSlotMs).toISOString().slice(0, 10), rung: v.rung,
        status: v.status, minNormalizedMargin: v.minNormalizedMargin, contractHash: v.contractHash })) })) };
  }

  guardStatus(): Record<string, unknown> {
    const episodes = this.tracker.getAll().flatMap(c => c.blockerEpisodes ?? []);
    const pending = episodes.filter(e => e.closedAtMs === undefined || e.clearTelemetryCompleteAtMs === undefined).length;
    return {
      enabled: true,
      loadBearing: false,
      status: !this.ledger.available() || pending >= 48 || this.now() < this.breakerUntil ? 'degraded' : 'healthy',
      pendingEpisodes: pending,
      breakerOpen: this.now() < this.breakerUntil,
      counters: this.ledger.counters(),
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.maturationTimer) clearInterval(this.maturationTimer);
    this.tracker.off('blocker-request-persisted', this.onRequest);
    this.tracker.off('blocker-episode-closed', this.onClose);
    this.tracker.off('delivered', this.onDelivered);
    this.ledger.close();
  }

  private clearRecord(episode: BlockerEpisode): BlockerMetricRecord {
    const observedAtMs = episode.closedAtMs ?? this.now();
    if (episode.startedAtMs === null) return {
      origin: this.origin, factor: 'clear-latency', sourceEventId: episode.clearSourceId!,
      observedAtMs, latencyMs: null, outcome: 'legacy-missing-start',
    };
    const duration = observedAtMs - episode.startedAtMs;
    if (duration < 0 || duration > 30 * 86_400_000) return {
      origin: this.origin, factor: 'clear-latency', sourceEventId: episode.clearSourceId!,
      observedAtMs, latencyMs: null, outcome: 'clock-regression-or-implausible',
    };
    return { origin: this.origin, factor: 'clear-latency', sourceEventId: episode.clearSourceId!,
      observedAtMs, latencyMs: duration, outcome: 'observed' };
  }

  private completionRecord(commitment: Commitment): BlockerMetricRecord | null {
    if (commitment.status !== 'delivered' || !commitment.resolvedAt) return null;
    const observedAtMs = Date.parse(commitment.resolvedAt);
    if (!Number.isFinite(observedAtMs)) return null;
    const opaqueId = crypto.createHash('sha256').update(`${this.origin}\0${commitment.id}`).digest('hex').slice(0, 32);
    return {
      origin: this.origin,
      factor: 'deliverable-completion',
      sourceEventId: `throughput-v1:completion:${opaqueId}`,
      observedAtMs,
      latencyMs: null,
      outcome: 'observed',
    };
  }

  private completionSummary(sinceMs: number, windowHours: number): Record<string, unknown> {
    const completed = this.ledger.values('deliverable-completion', sinceMs)
      .filter(row => row.outcome === 'observed').length;
    const windowDays = windowHours / 24;
    return {
      factor: 'deliverable-completion', unit: 'count', recoverability: 'reconcilable',
      window: { kind: 'rolling-hours', hours: windowHours },
      completed, total: completed, missing: 0, excluded: 0,
      coverage: completed === 0 ? null : 1,
      averagePerDay: completed / windowDays,
      medianMs: null, p95Ms: null,
      outcomes: { observed: completed, 'legacy-missing-start': 0,
        'clock-regression-or-implausible': 0, 'request-row-missing': 0,
        'episode-dropped-capacity': 0 },
    };
  }

  private completionTrend(sinceMs: number, windowDays: number): Record<string, unknown> {
    const todayStart = Date.parse(`${new Date(this.now()).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const counts = new Map<string, number>();
    const observed = this.ledger.values('deliverable-completion', sinceMs)
      .filter(row => row.outcome === 'observed');
    for (const row of observed) {
      const day = new Date(row.observedAtMs).toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const completeDays = Math.max(0, Math.min(89, windowDays - 1));
    const days = Array.from({ length: completeDays }, (_, index) => {
      const at = todayStart - (completeDays - index) * 86_400_000;
      const day = new Date(at).toISOString().slice(0, 10);
      return { day, count: counts.get(day) ?? 0 };
    });
    const currentDay = new Date(todayStart).toISOString().slice(0, 10);
    let cumulative = 0;
    const cumulativeDays = [...days, { day: currentDay, count: counts.get(currentDay) ?? 0 }]
      .map(day => ({ ...day, cumulative: (cumulative += day.count), complete: day.day !== currentDay }));
    const live = {
      window: { kind: 'rolling-days', days: windowDays, dailyBuckets: 'utc', currentDay: 'partial' },
      windowTotal: observed.length,
      currentDayCount: counts.get(currentDay) ?? 0,
      cumulativeDays,
    };
    const split = Math.floor(days.length / 2);
    const describe = (part: typeof days) => {
      const total = part.reduce((sum, day) => sum + day.count, 0);
      return { days: part.length, total, meanPerDay: part.length === 0 ? null : total / part.length };
    };
    const firstHalf = describe(days.slice(0, split));
    const secondHalf = describe(days.slice(split));
    if (days.length < 4 || firstHalf.days < 2 || secondHalf.days < 2) {
      return { factor: 'deliverable-completion', unit: 'count', ...live, days, firstHalf, secondHalf,
        ratio: null, direction: 'insufficient-data', reason: 'insufficient-days' };
    }
    if (firstHalf.meanPerDay === null || firstHalf.meanPerDay === 0) {
      return { factor: 'deliverable-completion', unit: 'count', ...live, days, firstHalf, secondHalf,
        ratio: null, direction: secondHalf.total > 0 ? 'climbing' : 'flat', reason: 'zero-denominator' };
    }
    const ratio = (secondHalf.meanPerDay ?? 0) / firstHalf.meanPerDay;
    return { factor: 'deliverable-completion', unit: 'count', ...live, days, firstHalf, secondHalf, ratio,
      direction: ratio > 1 ? 'climbing' : ratio < 1 ? 'declining' : 'flat', reason: null };
  }

  private factorSummary(factor: BlockerFactor, sinceMs: number): Record<string, unknown> {
    const rows = this.ledger.values(factor, sinceMs);
    const observed = rows.filter(r => r.outcome === 'observed' && r.latencyMs !== null).map(r => r.latencyMs!);
    const derived = this.derivedCounters(sinceMs);
    const legacy = factor === 'clear-latency' ? rows.filter(r => r.outcome === 'legacy-missing-start').length : 0;
    const clock = factor === 'clear-latency' ? rows.filter(r => r.outcome === 'clock-regression-or-implausible').length : 0;
    const requestMissing = factor === 'request-to-persist' ? derived.requestSamplesMissing : 0;
    const dropped = factor === 'request-to-persist' ? derived.requestDroppedCapacity : derived.clearDroppedCapacity;
    const missing = requestMissing + dropped;
    const excluded = legacy + clock;
    const denominator = observed.length + missing + excluded;
    return {
      factor,
      recoverability: factor === 'request-to-persist' ? 'best-effort' : 'reconcilable',
      completed: observed.length, missing, excluded,
      coverage: denominator === 0 ? null : observed.length / denominator,
      medianMs: percentile(observed, 0.5), p95Ms: percentile(observed, 0.95),
      outcomes: { observed: observed.length, 'legacy-missing-start': legacy,
        'clock-regression-or-implausible': clock, 'request-row-missing': requestMissing,
        'episode-dropped-capacity': dropped },
    };
  }

  private factorTrend(factor: BlockerFactor, sinceMs: number): Record<string, unknown> {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const grouped = new Map<string, number[]>();
    for (const row of this.ledger.values(factor, sinceMs)) {
      if (row.outcome !== 'observed' || row.latencyMs === null) continue;
      const day = new Date(row.observedAtMs).toISOString().slice(0, 10);
      if (day === today) continue;
      const values = grouped.get(day) ?? [];
      values.push(row.latencyMs); grouped.set(day, values);
    }
    const days = [...grouped.entries()].filter(([, v]) => v.length >= 3).sort(([a], [b]) => a.localeCompare(b))
      .map(([day, values]) => ({ day, medianMs: percentile(values, 0.5)!, samples: values.length }));
    const empty = (reason: FailureReason) => ({ factor, days, firstHalf: { days: 0, samples: 0, meanMs: null },
      secondHalf: { days: 0, samples: 0, meanMs: null }, ratio: null, reason });
    if (days.length < 6) return empty('insufficient-days');
    const split = Math.floor(days.length / 2);
    const halves = [days.slice(0, split), days.slice(split)];
    const describe = (part: typeof days) => ({ days: part.length, samples: part.reduce((n, d) => n + d.samples, 0),
      meanMs: part.reduce((n, d) => n + d.medianMs, 0) / part.length });
    const first = describe(halves[0]); const second = describe(halves[1]);
    if (first.days < 2 || second.days < 2 || first.samples < 9 || second.samples < 9) return empty('insufficient-samples');
    if (first.meanMs === 0) return { ...empty('zero-denominator'), firstHalf: first, secondHalf: second };
    return { factor, days, firstHalf: first, secondHalf: second, ratio: second.meanMs / first.meanMs, reason: null };
  }

  private derivedCounters(sinceMs: number): { requestSamplesMissing: number; requestDroppedCapacity: number; clearDroppedCapacity: number } {
    let requestSamplesMissing = 0;
    for (const c of this.tracker.getAll()) for (const e of c.blockerEpisodes ?? []) {
      if (!e.requestEventExpected || e.startedAtMs === null || e.startedAtMs < sinceMs) continue;
      const id = `blocker-lifecycle-v1:request:${e.episodeId}`;
      if (!this.ledger.has(this.origin, 'request-to-persist', id)) requestSamplesMissing++;
    }
    let requestDroppedCapacity = 0; let clearDroppedCapacity = 0;
    for (const [day, bucket] of Object.entries(this.tracker.getBlockerEpisodeDropBuckets())) {
      if (Date.parse(`${day}T00:00:00.000Z`) < sinceMs) continue;
      requestDroppedCapacity += bucket.request; clearDroppedCapacity += bucket.clear;
    }
    return { requestSamplesMissing, requestDroppedCapacity, clearDroppedCapacity };
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.reconcile(), ms);
    this.timer.unref?.();
  }

  private reconcile(): void {
    if (this.closed) return;
    if (this.now() < this.breakerUntil) { this.schedule(Math.min(300_000, this.breakerUntil - this.now())); return; }
    const commitments = this.tracker.getAll().sort((a, b) => a.id.localeCompare(b.id));
    const slice = commitments.slice(this.cursor, this.cursor + 64);
    const sweepComplete = commitments.length === 0 || this.cursor + slice.length >= commitments.length;
    this.cursor = sweepComplete ? 0 : this.cursor + slice.length;
    let failed = false;
    for (const c of slice) for (const episode of c.blockerEpisodes ?? []) {
      if (episode.closedAtMs === undefined || !episode.clearSourceId) continue;
      const ok = this.ledger.record(this.clearRecord(episode), true);
      if (!ok) { failed = true; break; }
      try { this.tracker.markBlockerClearTelemetryComplete(c.id, episode.episodeId, this.now()); }
      catch { /* @silent-fallback-ok — failed drives bounded backoff/breaker */ failed = true; }
    }
    for (const commitment of slice) {
      const completion = this.completionRecord(commitment);
      if (completion && !this.ledger.record(completion, true)) failed = true;
    }
    if (failed) {
      this.failures++;
      if (this.failures >= 6) { this.breakerUntil = this.now() + 15 * 60_000; this.schedule(15 * 60_000); }
      else this.schedule(Math.min(300_000, 5_000 * 2 ** (this.failures - 1)));
    } else {
      this.failures = 0;
      if (sweepComplete) this.ledger.prune();
      // A mature store can contain hundreds of commitments. Drain the bounded
      // 64-row slices back-to-back on startup/recovery so recent completions at
      // the tail do not sit at zero for five minutes per slice. The five-minute
      // cadence begins only after a complete sweep.
      this.schedule(sweepComplete ? 5 * 60_000 : 0);
    }
  }
}

import type { CommitmentTracker, BlockerEpisode } from './CommitmentTracker.js';
import { BlockerLifecycleLedger, percentile, type BlockerFactor, type BlockerMetricRecord } from './BlockerLifecycleLedger.js';

type FailureReason = 'insufficient-days' | 'insufficient-samples' | 'zero-denominator';

export class BlockerLifecycleService {
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private breakerUntil = 0;
  private closed = false;
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

  constructor(
    private readonly tracker: CommitmentTracker,
    readonly ledger: BlockerLifecycleLedger,
    private readonly origin: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    tracker.on('blocker-request-persisted', this.onRequest);
    tracker.on('blocker-episode-closed', this.onClose);
    this.schedule(5_000);
  }

  available(): boolean { return this.ledger.available(); }

  localSummary(sinceHours: number): Record<string, unknown> {
    const sinceMs = this.now() - sinceHours * 3_600_000;
    return {
      machineId: this.origin,
      factors: (['request-to-persist', 'clear-latency'] as const).map(f => this.factorSummary(f, sinceMs)),
      counters: { ...this.ledger.counters(), ...this.derivedCounters(sinceMs), breakerOpen: this.now() < this.breakerUntil },
    };
  }

  localTrend(windowDays: number): Record<string, unknown> {
    const sinceMs = this.now() - windowDays * 86_400_000;
    return {
      machineId: this.origin,
      factors: (['request-to-persist', 'clear-latency'] as const).map(f => this.factorTrend(f, sinceMs)),
    };
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
    this.tracker.off('blocker-request-persisted', this.onRequest);
    this.tracker.off('blocker-episode-closed', this.onClose);
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
    this.cursor = commitments.length === 0 || this.cursor + slice.length >= commitments.length ? 0 : this.cursor + slice.length;
    let failed = false;
    for (const c of slice) for (const episode of c.blockerEpisodes ?? []) {
      if (episode.closedAtMs === undefined || !episode.clearSourceId) continue;
      const ok = this.ledger.record(this.clearRecord(episode), true);
      if (!ok) { failed = true; break; }
      try { this.tracker.markBlockerClearTelemetryComplete(c.id, episode.episodeId, this.now()); }
      catch { /* @silent-fallback-ok — failed drives bounded backoff/breaker */ failed = true; }
    }
    if (failed) {
      this.failures++;
      if (this.failures >= 6) { this.breakerUntil = this.now() + 15 * 60_000; this.schedule(15 * 60_000); }
      else this.schedule(Math.min(300_000, 5_000 * 2 ** (this.failures - 1)));
    } else { this.failures = 0; this.ledger.prune(); this.schedule(5 * 60_000); }
  }
}

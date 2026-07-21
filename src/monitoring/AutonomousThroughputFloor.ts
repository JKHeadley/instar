/**
 * AutonomousThroughputFloor — PULL/AUDIT-ONLY v1.
 *
 * This monitor has no notification, dispatch, remediation, or attention seam.
 * It measures bounded repository deliverable movement and manager outbound
 * silence, persists a restart-safe read breaker, and exposes scrubbed status.
 */

export interface DeliverableSnapshot {
  merged: Array<{ number: number; mergeCommitSha: string }>;
  open: Array<{ number: number; headSha: string; treeSha: string; descendsPrevious?: boolean }>;
  digest: string;
}

export interface ThroughputRun {
  signalRunId: string;
  topicId: number;
  startedAt: number;
  telegramBacked: boolean;
  registeredMachineCount: number;
  midMove: boolean;
}

export type SweepFailureClass = 'timeout' | 'rate-limited' | 'auth' | 'invalid-scope' | 'git-read' | 'github-read';

export type DeliverableSweepResult =
  | { status: 'ok'; snapshot: DeliverableSnapshot; meaningfulDelta: boolean }
  | { status: 'unknown'; failure: SweepFailureClass };

export interface OutboundObservation {
  coverage: 'proven' | 'unknown';
  newestOutboundAt?: number;
  cursor?: string;
}

export interface ThroughputFloorRunState {
  version: 1;
  signalRunId: string;
  lastSnapshot?: DeliverableSnapshot;
  lastDeliverableDeltaAt: number;
  lastManagerOutboundAt: number;
  lastHistoryCursor?: string;
  consecutiveSweepFailures: number;
  nextSweepAt: number;
  breakerOpenUntil?: number;
  flatlineObservedAt?: number;
}

export interface ThroughputFloorAudit {
  signalRunId: string;
  topicId: number;
  at: number;
  decision: 'baseline' | 'healthy' | 'flatline-observed' | 'unknown' | 'ineligible' | 'breaker-open';
  reason: string;
  outputFlatForMs?: number;
  managerSilentForMs?: number;
  failure?: SweepFailureClass;
}

export interface AutonomousThroughputFloorDeps {
  listRuns(): ThroughputRun[];
  sweep(run: ThroughputRun, previous?: DeliverableSnapshot): Promise<DeliverableSweepResult>;
  observeOutbound(run: ThroughputRun, cursor?: string): Promise<OutboundObservation> | OutboundObservation;
  loadState(signalRunId: string): ThroughputFloorRunState | { corrupt: true } | null;
  saveState(signalRunId: string, state: ThroughputFloorRunState): void;
  audit(row: ThroughputFloorAudit): void;
  now?: () => number;
}

export interface AutonomousThroughputFloorConfig {
  enabled?: boolean;
  flatlineMs?: number;
  tickMs?: number;
}

const DEFAULT_FLATLINE_MS = 75 * 60_000;
const DEFAULT_TICK_MS = 15 * 60_000;
const FAILURE_BACKOFF = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
const OPEN_BREAKER_MS = 6 * 60 * 60_000;

export function hasMeaningfulDeliverableDelta(before: DeliverableSnapshot, after: DeliverableSnapshot): boolean {
  const merged = new Set(before.merged.map(row => `${row.number}:${row.mergeCommitSha}`));
  if (after.merged.some(row => !merged.has(`${row.number}:${row.mergeCommitSha}`))) return true;
  const prior = new Map(before.open.map(row => [row.number, row]));
  return after.open.some(row => {
    const old = prior.get(row.number);
    return Boolean(old && old.headSha !== row.headSha && old.treeSha !== row.treeSha && row.descendsPrevious === true);
  });
}

/** Preserved invariant. v1 never has lane-saturation authority, so production callers pass false. */
export function deterministicHoldAllowed(input: { openApprovalGate: boolean; allNonGatedLanesSaturated: boolean }): boolean {
  return input.openApprovalGate === true && input.allNonGatedLanesSaturated === true;
}

/** Runtime authority is deliberately exhausted by state/audit writes and status reads. */
export class AutonomousThroughputFloor {
  private readonly enabled: boolean;
  private readonly flatlineMs: number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private lastTickAt = 0;
  private readonly latest = new Map<string, ThroughputFloorAudit>();

  constructor(private readonly deps: AutonomousThroughputFloorDeps, cfg: AutonomousThroughputFloorConfig = {}) {
    this.enabled = cfg.enabled === true;
    this.flatlineMs = Math.max(DEFAULT_FLATLINE_MS, cfg.flatlineMs ?? DEFAULT_FLATLINE_MS);
    this.tickMs = Math.max(DEFAULT_TICK_MS, cfg.tickMs ?? DEFAULT_TICK_MS);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  guardStatus() { return { enabled: this.enabled, mode: 'pull-audit-only' as const, lastTickAt: this.lastTickAt, tickInFlight: this.tickInFlight }; }
  status() { return { ...this.guardStatus(), flatlineMinutes: this.flatlineMs / 60_000, runs: [...this.latest.values()] }; }

  async tick(): Promise<void> {
    if (!this.enabled || this.tickInFlight) return;
    this.tickInFlight = true;
    const now = (this.deps.now ?? Date.now)();
    this.lastTickAt = now;
    try { for (const run of this.deps.listRuns()) await this.evaluate(run, now); }
    finally { this.tickInFlight = false; }
  }

  private async evaluate(run: ThroughputRun, now: number): Promise<void> {
    if (!validRun(run) || !run.telegramBacked || run.registeredMachineCount !== 1 || run.midMove) {
      return this.record(run, now, 'ineligible', 'scope-or-ownership-ineligible');
    }
    const loaded = this.deps.loadState(run.signalRunId);
    if (loaded && 'corrupt' in loaded) return this.record(run, now, 'unknown', 'state-corrupt');
    let state = loaded;
    if (state && (state.version !== 1 || state.signalRunId !== run.signalRunId || invalidTime(state.lastDeliverableDeltaAt, now) || invalidTime(state.lastManagerOutboundAt, now))) {
      return this.record(run, now, 'unknown', 'state-invalid');
    }
    if (state?.breakerOpenUntil && state.breakerOpenUntil > now) {
      return this.record(run, now, 'breaker-open', 'read-breaker-open');
    }
    if (state && state.nextSweepAt > now) return;

    let outbound: OutboundObservation;
    try { outbound = await this.deps.observeOutbound(run, state?.lastHistoryCursor); }
    catch { outbound = { coverage: 'unknown' }; }
    if (outbound.coverage !== 'proven') return this.record(run, now, 'unknown', 'history-coverage-unknown');

    let sweep: DeliverableSweepResult;
    try { sweep = await this.deps.sweep(run, state?.lastSnapshot); }
    catch { sweep = { status: 'unknown', failure: 'github-read' }; }
    if (sweep.status === 'unknown') {
      state ??= baseline(run, now, outbound);
      state.consecutiveSweepFailures += 1;
      if (state.consecutiveSweepFailures > FAILURE_BACKOFF.length) state.breakerOpenUntil = now + OPEN_BREAKER_MS;
      state.nextSweepAt = state.breakerOpenUntil ?? now + FAILURE_BACKOFF[Math.min(state.consecutiveSweepFailures - 1, FAILURE_BACKOFF.length - 1)];
      state.lastHistoryCursor = outbound.cursor ?? state.lastHistoryCursor;
      this.deps.saveState(run.signalRunId, state);
      return this.record(run, now, 'unknown', 'sweep-unknown', undefined, undefined, sweep.failure);
    }

    if (!state) {
      state = baseline(run, now, outbound);
      state.lastSnapshot = sweep.snapshot;
      this.deps.saveState(run.signalRunId, state);
      return this.record(run, now, 'baseline', 'first-successful-observation');
    }
    state.consecutiveSweepFailures = 0;
    state.breakerOpenUntil = undefined;
    state.nextSweepAt = now + this.tickMs;
    if (sweep.meaningfulDelta) {
      state.lastDeliverableDeltaAt = now;
      state.flatlineObservedAt = undefined;
    }
    if (outbound.newestOutboundAt && outbound.newestOutboundAt > state.lastManagerOutboundAt) {
      state.lastManagerOutboundAt = outbound.newestOutboundAt;
      state.flatlineObservedAt = undefined;
    }
    state.lastSnapshot = sweep.snapshot;
    state.lastHistoryCursor = outbound.cursor ?? state.lastHistoryCursor;
    const outputFlatForMs = Math.max(0, now - state.lastDeliverableDeltaAt);
    const managerSilentForMs = Math.max(0, now - state.lastManagerOutboundAt);
    const flatline = outputFlatForMs >= this.flatlineMs && managerSilentForMs >= this.flatlineMs;
    if (flatline && !state.flatlineObservedAt) state.flatlineObservedAt = now;
    this.deps.saveState(run.signalRunId, state);
    return this.record(run, now, flatline ? 'flatline-observed' : 'healthy', flatline ? 'dual-flatline' : 'within-floor', outputFlatForMs, managerSilentForMs);
  }

  private record(run: Pick<ThroughputRun, 'signalRunId' | 'topicId'>, at: number, decision: ThroughputFloorAudit['decision'], reason: string, outputFlatForMs?: number, managerSilentForMs?: number, failure?: SweepFailureClass): void {
    const row = { signalRunId: run.signalRunId, topicId: run.topicId, at, decision, reason, outputFlatForMs, managerSilentForMs, failure };
    this.latest.set(run.signalRunId, row);
    this.deps.audit(row);
  }
}

function baseline(run: ThroughputRun, now: number, outbound: OutboundObservation): ThroughputFloorRunState {
  return { version: 1, signalRunId: run.signalRunId, lastDeliverableDeltaAt: now, lastManagerOutboundAt: Math.max(run.startedAt, outbound.newestOutboundAt ?? run.startedAt), lastHistoryCursor: outbound.cursor, consecutiveSweepFailures: 0, nextSweepAt: now };
}
function validRun(run: ThroughputRun): boolean { return Boolean(run.signalRunId) && Number.isSafeInteger(run.topicId) && run.topicId > 0 && Number.isFinite(run.startedAt) && run.startedAt > 0; }
function invalidTime(value: number, now: number): boolean { return !Number.isFinite(value) || value < 0 || value > now + 30_000; }

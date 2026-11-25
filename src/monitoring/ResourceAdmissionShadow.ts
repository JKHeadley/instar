// Advisory only. This module cannot reserve resources or change launch decisions.
export interface ResourceAdmissionSample {
  capturedAtMs: number;
  nativePressure: 'normal' | 'warning' | 'critical';
  availableBytes?: number;
  cpuUtilization?: number;
  swapTrendBytes?: number;
}

export interface ShadowAdmissionInput {
  nowMs: number;
  maxSampleAgeMs: number;
  sample?: ResourceAdmissionSample;
  calibratedDemandBytes?: number;
  recoveryReserveBytes?: number;
  /** Remaining startup growth, attributable to this same host sample. */
  startupAccounting?: {
    sampleCapturedAtMs: number;
    remainingGrowthBytes: number;
    errorBoundBytes: number;
  };
}

export type ShadowAdmissionDecision =
  | { verdict: 'unknown'; reason: string }
  | { verdict: 'pressure-policy-excluded'; reason: 'native-warning' | 'native-critical' }
  | { verdict: 'fit' | 'insufficient-memory'; marginBytes: number };

function isNonnegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function compareResourceAdmission(input: ShadowAdmissionInput): ShadowAdmissionDecision {
  const { nowMs, maxSampleAgeMs, sample, calibratedDemandBytes, recoveryReserveBytes, startupAccounting } = input;
  if (!sample || !isNonnegative(nowMs) || !isNonnegative(maxSampleAgeMs) ||
      !isNonnegative(sample.capturedAtMs) || sample.capturedAtMs > nowMs ||
      nowMs - sample.capturedAtMs > maxSampleAgeMs) {
    return { verdict: 'unknown', reason: 'pressure-sample-unavailable-or-stale' };
  }
  if (sample.nativePressure === 'warning' || sample.nativePressure === 'critical') {
    return { verdict: 'pressure-policy-excluded', reason: `native-${sample.nativePressure}` };
  }
  if (sample.nativePressure !== 'normal' || !isNonnegative(sample.availableBytes)) {
    return { verdict: 'unknown', reason: 'available-memory-unverified' };
  }
  if (!isNonnegative(calibratedDemandBytes) || !isNonnegative(recoveryReserveBytes)) {
    return { verdict: 'unknown', reason: 'startup-demand-or-recovery-reserve-unverified' };
  }
  if (!startupAccounting || startupAccounting.sampleCapturedAtMs !== sample.capturedAtMs ||
      !isNonnegative(startupAccounting.remainingGrowthBytes) || !isNonnegative(startupAccounting.errorBoundBytes)) {
    return { verdict: 'unknown', reason: 'startup-accounting-unverified' };
  }
  const marginBytes = sample.availableBytes - recoveryReserveBytes -
    calibratedDemandBytes - startupAccounting.remainingGrowthBytes;
  const error = startupAccounting.errorBoundBytes;
  if (marginBytes - error >= 0) return { verdict: 'fit', marginBytes };
  if (marginBytes + error < 0) return { verdict: 'insufficient-memory', marginBytes };
  return { verdict: 'unknown', reason: 'attribution-error-can-change-verdict' };
}

export interface SessionCountObservation {
  path: 'normal' | 'interactive';
  count: number;
  limit: number;
  countRefused: boolean;
}

export type ShadowLaunchOutcome = 'not-applicable' | 'pending' | 'runner-created' | 'unresolved';
export type RecordShadowOutcome = (outcome: 'runner-created' | 'unresolved') => void;

export interface ShadowAdmissionReceipt extends SessionCountObservation {
  attempt: number;
  launchOutcome: ShadowLaunchOutcome;
  decision: ShadowAdmissionDecision;
  sampleCapturedAtMs: number | null;
  nativePressure: ResourceAdmissionSample['nativePressure'] | null;
  availableBytes: number | null;
}

/** Fixed-size diagnostics window. No I/O occurs when a session is admitted. */
export class ResourceAdmissionShadowReport {
  private sequence = 0;
  private readonly rows: ShadowAdmissionReceipt[] = [];

  constructor(
    private readonly host: string,
    private readonly readInput: () => ShadowAdmissionInput,
    private readonly capacity = 128,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Shadow report capacity must be a positive integer');
    }
  }

  observe = (observation: SessionCountObservation): RecordShadowOutcome | undefined => {
    const input = this.readInput();
    const index = this.sequence % this.capacity;
    const receipt: ShadowAdmissionReceipt = {
      ...observation,
      attempt: ++this.sequence,
      launchOutcome: observation.countRefused ? 'not-applicable' : 'pending',
      decision: compareResourceAdmission(input),
      sampleCapturedAtMs: input.sample?.capturedAtMs ?? null,
      nativePressure: input.sample?.nativePressure ?? null,
      availableBytes: input.sample?.availableBytes ?? null,
    };
    this.rows[index] = receipt;
    if (observation.countRefused) return undefined;
    return (outcome) => {
      if (this.rows[index] === receipt && receipt.launchOutcome === 'pending') {
        receipt.launchOutcome = outcome;
      }
    };
  };

  snapshot() {
    const recent = this.rows.map((row) => ({ ...row, decision: { ...row.decision } }))
      .sort((left, right) => left.attempt - right.attempt);
    return {
      host: this.host,
      observed: this.sequence,
      retained: recent.length,
      launchPending: recent.filter(({ launchOutcome }) => launchOutcome === 'pending').length,
      launchUnresolved: recent.filter(({ launchOutcome }) => launchOutcome === 'unresolved').length,
      unknown: recent.filter(({ decision }) => decision.verdict === 'unknown').length,
      countRefusedButFits: recent.filter(({ countRefused, decision }) =>
        countRefused && decision.verdict === 'fit').length,
      countPassedButInsufficient: recent.filter(({ countRefused, decision }) =>
        !countRefused && decision.verdict === 'insufficient-memory').length,
      recent,
    };
  }
}

export interface StartupMemoryPoint {
  atMs: number;
  processTreeResidentBytes: number;
  hostAvailableBytes: number;
}

export interface StartupCalibrationTrace {
  /** All points must refer to the same verified process tree and isolated host episode. */
  isolated: boolean;
  createdAtMs: number;
  readyAtMs: number;
  windowEndMs: number;
  points: readonly StartupMemoryPoint[];
}

/** Reduce a controlled trace. The caller owns identity, isolation and coverage evidence. */
export function calibrateStartupMemory(trace: StartupCalibrationTrace) {
  const { points, createdAtMs, readyAtMs, windowEndMs } = trace;
  if (!trace.isolated || ![createdAtMs, readyAtMs, windowEndMs].every(isNonnegative) ||
      readyAtMs < createdAtMs || windowEndMs < readyAtMs || points.length < 2 ||
      points[0].atMs !== createdAtMs || points[points.length - 1].atMs < windowEndMs) return undefined;

  const baseline = points[0];
  let prior = -1;
  let peakGrowthBytes = 0;
  let peakResidentBytes = 0;
  let attributionErrorBytes = 0;
  let minimumAvailableBytes = Infinity;
  for (const point of points) {
    if (![point.atMs, point.processTreeResidentBytes, point.hostAvailableBytes].every(isNonnegative) ||
        point.atMs <= prior) return undefined;
    prior = point.atMs;
    const growth = Math.max(0, point.processTreeResidentBytes - baseline.processTreeResidentBytes);
    const hostDrop = Math.max(0, baseline.hostAvailableBytes - point.hostAvailableBytes);
    peakGrowthBytes = Math.max(peakGrowthBytes, growth);
    peakResidentBytes = Math.max(peakResidentBytes, point.processTreeResidentBytes);
    attributionErrorBytes = Math.max(attributionErrorBytes, Math.abs(growth - hostDrop));
    minimumAvailableBytes = Math.min(minimumAvailableBytes, point.hostAvailableBytes);
  }
  return { peakGrowthBytes, peakResidentBytes, attributionErrorBytes, minimumAvailableBytes };
}

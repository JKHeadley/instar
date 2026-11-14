/** Outcome metadata and read-only evidence on D7's existing measurement owner.
 * Shape and arithmetic are signals; accountable review judges improvement.
 */
import type { MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import type { MaturationMetricObservation } from './BlockerLifecycleLedger.js';

export interface MaturationBaselinePoint {
  id: string;
  observedAtMs: number;
  descriptorVersion: number;
  value: number;
  samples: number;
}
export interface MaturationOutcomeContract {
  statement: string;
  owner: string;
  method: string;
  version: string;
  outcomeMetricIds: string[];
  qualityMetricIds: string[];
  baseline: { origin: string; points: MaturationBaselinePoint[] };
}

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const time = (v: unknown): v is number => integer(v, 1) && (v as number) <= 8_640_000_000_000_000;

/** Shared by source-scanned contracts and ladder-generated contracts. It does
 * not apply the scanner's source-ref allowlist to dynamic ladder projections. */
export function parseMaturationOutcome(raw: unknown, metricIds: readonly string[]): MaturationOutcomeContract | null {
  if (!object(raw) || !keys(raw, ['statement', 'owner', 'method', 'version', 'outcomeMetricIds', 'qualityMetricIds', 'baseline']) ||
      !text(raw.statement, 500) || !text(raw.owner, 120) || !text(raw.method, 500) ||
      typeof raw.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.version)) return null;
  const ids = new Set(metricIds);
  if (ids.size < 1 || ids.size > 16 || ids.size !== metricIds.length) return null;
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= 16 &&
    v.every(id => typeof id === 'string' && ids.has(id)) && new Set(v).size === v.length;
  if (!list(raw.outcomeMetricIds) || !list(raw.qualityMetricIds) || !object(raw.baseline) ||
      !keys(raw.baseline, ['origin', 'points']) || typeof raw.baseline.origin !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.baseline.origin) || !Array.isArray(raw.baseline.points) ||
      raw.baseline.points.length !== ids.size) return null;
  const points: MaturationBaselinePoint[] = [];
  const seen = new Set<string>();
  for (const p of raw.baseline.points) {
    if (!object(p) || !keys(p, ['id', 'observedAtMs', 'descriptorVersion', 'value', 'samples']) ||
        typeof p.id !== 'string' || !ids.has(p.id) || seen.has(p.id) || !time(p.observedAtMs) ||
        !integer(p.descriptorVersion, 1) || typeof p.value !== 'number' || !Number.isFinite(p.value) || !integer(p.samples, 0) || p.samples > 100_000) return null;
    seen.add(p.id);
    points.push({ id: p.id, observedAtMs: p.observedAtMs, descriptorVersion: p.descriptorVersion, value: p.value, samples: p.samples });
  }
  return { statement: raw.statement, owner: raw.owner, method: raw.method, version: raw.version,
    outcomeMetricIds: [...raw.outcomeMetricIds], qualityMetricIds: [...raw.qualityMetricIds],
    baseline: { origin: raw.baseline.origin, points } };
}

export type OutcomeEvidenceState = 'verified' | 'unavailable' | 'mismatch' | 'foreign-origin' | 'future' | 'stale' | 'before-baseline' | 'insufficient-samples';
export type ReadMaturationObservation = (metricId: string, observedAtMs?: number) => MaturationMetricObservation | null;

/** Structural policy validation shared by read projections; dynamic ladder refs remain valid. */
export function validMaturationPolicy(contract: MaturationEvaluationContract | undefined): boolean {
  if (!contract) return false;
  return !(!integer(contract.cadenceHours, 6) || contract.cadenceHours > 168 || contract.cadenceHours % 6 !== 0 ||
      !integer(contract.evidenceMaxAgeHours, contract.cadenceHours) || contract.evidenceMaxAgeHours > Math.min(168, contract.cadenceHours * 2) ||
      !Array.isArray(contract.metrics) || contract.metrics.length < 1 || contract.metrics.length > 16 ||
      contract.metrics.some(m => !m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(m.id) ||
        !['blocker-summary', 'blocker-trend', 'feature-summary'].includes(m.source) || !text(m.sourceRef, 128) ||
        !['at-least', 'at-most'].includes(m.direction) || !Number.isFinite(m.threshold) || !integer(m.minSamples, 1) || m.minSamples > 100_000)) && new Set(contract.metrics.map(m => m.id)).size === contract.metrics.length;
}

/** Uses exact baseline and latest-overall current reads. It never falls back
 * to an older, more flattering matching row after a source/version change. */
export function projectMaturationOutcome(contract: MaturationEvaluationContract | undefined, origin: string,
  featureId: string, now: number, read: ReadMaturationObservation) {
  if (contract?.outcome === undefined) return { state: 'missing-contract' as const, metrics: [] };
  if (!validMaturationPolicy(contract)) return { state: 'invalid-contract' as const, metrics: [] };
  const outcome = parseMaturationOutcome(contract.outcome, contract.metrics.map(m => m.id));
  if (!outcome) return { state: 'invalid-contract' as const, metrics: [] };
  const rows = contract.metrics.map(metric => {
    const point = outcome.baseline.points.find(p => p.id === metric.id)!;
    let baseline: MaturationMetricObservation | null = null;
    let current: MaturationMetricObservation | null = null;
    // A failed owner read is unknown evidence, never an exception in service.
    try { if (outcome.baseline.origin === origin) baseline = read(metric.id, point.observedAtMs); } catch { /* @silent-fallback-ok — explicit unavailable evidence below */ }
    try { current = read(metric.id); } catch { /* @silent-fallback-ok — explicit unavailable evidence below */ }
    const matches = (row: MaturationMetricObservation) => row.origin === origin && row.featureId === featureId &&
      row.metricId === metric.id && row.source === metric.source && row.sourceRef === metric.sourceRef &&
      (row.descriptorVersion ?? 1) === point.descriptorVersion && time(row.observedAtMs) &&
      Number.isFinite(row.value) && integer(row.samples, 0) && row.samples <= 100_000;
    const baselineState: OutcomeEvidenceState = !time(now) ? 'unavailable' : outcome.baseline.origin !== origin ? 'foreign-origin'
      : point.observedAtMs > now ? 'future' : !baseline ? 'unavailable'
      : !matches(baseline) || baseline.observedAtMs !== point.observedAtMs || baseline.value !== point.value || baseline.samples !== point.samples ? 'mismatch'
      : baseline.samples < metric.minSamples ? 'insufficient-samples' : 'verified';
    const currentState: OutcomeEvidenceState = !time(now) || !current ? 'unavailable' : !matches(current) ? 'mismatch'
      : current.observedAtMs > now ? 'future' : current.observedAtMs < point.observedAtMs ? 'before-baseline'
      : now - current.observedAtMs > contract.evidenceMaxAgeHours * 3_600_000 ? 'stale'
      : current.samples < metric.minSamples ? 'insufficient-samples' : 'verified';
    const rawDelta = baselineState === 'verified' && currentState === 'verified' ? current!.value - point.value : null;
    const delta = rawDelta !== null && Number.isFinite(rawDelta) ? rawDelta : null;
    return { id: metric.id, source: metric.source, sourceRef: metric.sourceRef, descriptorVersion: point.descriptorVersion,
      outcome: outcome.outcomeMetricIds.includes(metric.id), qualityGuard: outcome.qualityMetricIds.includes(metric.id),
      baseline: { state: baselineState, ...point },
      current: { state: currentState, observedAtMs: current?.observedAtMs ?? null,
        value: currentState === 'verified' ? current!.value : null, samples: current?.samples ?? null },
      delta, comparisonAvailable: delta !== null,
      criterion: { direction: metric.direction, threshold: metric.threshold, minSamples: metric.minSamples,
        met: currentState !== 'verified' ? null : metric.direction === 'at-least' ? current!.value >= metric.threshold : current!.value <= metric.threshold },
    };
  });
  return { state: rows.every(r => r.comparisonAvailable) ? 'verified' as const : 'unverified' as const,
    statement: outcome.statement, owner: outcome.owner, method: outcome.method, version: outcome.version,
    baselineOrigin: outcome.baseline.origin, evidenceMaxAgeHours: contract.evidenceMaxAgeHours, metrics: rows };
}

/** Validate the bounded projection from an authenticated peer; this checks
 * shape/arithmetic, not the peer's underlying observation store. */
export function validMaturationOutcomeDetail(raw: unknown, expectedOrigin: string, now = Date.now()): boolean {
  if (!time(now)) return false;
  if (!object(raw) || !keys(raw, ['featureId', 'subjectKnown', 'evidence']) ||
      typeof raw.featureId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(raw.featureId) ||
      typeof raw.subjectKnown !== 'boolean' || !object(raw.evidence)) return false;
  if (Buffer.byteLength(JSON.stringify(raw)) > 32 * 1024) return false;
  const e = raw.evidence;
  if (!keys(e, ['state', 'metrics', 'statement', 'owner', 'method', 'version', 'baselineOrigin', 'evidenceMaxAgeHours']) ||
      !Array.isArray(e.metrics) || e.metrics.length > 16) return false;
  if (e.state === 'missing-contract' || e.state === 'invalid-contract') return e.metrics.length === 0 && Object.keys(e).length === 2;
  if (!['verified', 'unverified'].includes(String(e.state)) || !text(e.statement, 500) || !text(e.owner, 120) ||
      !text(e.method, 500) || typeof e.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.version) ||
      typeof e.baselineOrigin !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(e.baselineOrigin) ||
      !integer(e.evidenceMaxAgeHours, 6) || e.evidenceMaxAgeHours > 168 || e.metrics.length < 1) return false;
  if (e.state === 'verified' && (!raw.subjectKnown || e.baselineOrigin !== expectedOrigin)) return false;
  const states = ['verified', 'unavailable', 'mismatch', 'foreign-origin', 'future', 'stale', 'before-baseline', 'insufficient-samples'];
  const ids = new Set<string>();
  let allComparisons = true;
  let outcomes = 0; let quality = 0;
  for (const p of e.metrics) {
    if (!object(p) || !keys(p, ['id', 'source', 'sourceRef', 'descriptorVersion', 'outcome', 'qualityGuard', 'baseline', 'current', 'delta', 'comparisonAvailable', 'criterion']) ||
        typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(p.id) || ids.has(p.id) ||
        !['blocker-summary', 'blocker-trend', 'feature-summary'].includes(String(p.source)) || !text(p.sourceRef, 128) ||
        !integer(p.descriptorVersion, 1) || typeof p.outcome !== 'boolean' || typeof p.qualityGuard !== 'boolean' ||
        !object(p.baseline) || !object(p.current) || !object(p.criterion)) return false;
    ids.add(p.id); if (p.outcome) outcomes++; if (p.qualityGuard) quality++;
    const b = p.baseline; const c = p.current; const criterion = p.criterion;
    if (!keys(b, ['state', 'id', 'observedAtMs', 'descriptorVersion', 'value', 'samples']) ||
        !states.includes(String(b.state)) || b.id !== p.id || !time(b.observedAtMs) || b.descriptorVersion !== p.descriptorVersion ||
        typeof b.value !== 'number' || !Number.isFinite(b.value) || !integer(b.samples, 0) || b.samples > 100_000 ||
        !keys(c, ['state', 'observedAtMs', 'value', 'samples']) || !states.includes(String(c.state)) ||
        !(c.observedAtMs === null || time(c.observedAtMs)) || !(c.samples === null || (integer(c.samples, 0) && c.samples <= 100_000)) ||
        !(c.value === null || (typeof c.value === 'number' && Number.isFinite(c.value))) ||
        !keys(criterion, ['direction', 'threshold', 'minSamples', 'met']) ||
        !['at-least', 'at-most'].includes(String(criterion.direction)) || typeof criterion.threshold !== 'number' || !Number.isFinite(criterion.threshold) ||
        !integer(criterion.minSamples, 1) || criterion.minSamples > 100_000 || !(criterion.met === null || typeof criterion.met === 'boolean')) return false;
    if (c.state === 'verified') {
      if (!time(c.observedAtMs) || c.observedAtMs > now || now - c.observedAtMs > e.evidenceMaxAgeHours * 3_600_000 ||
          c.observedAtMs < b.observedAtMs || !integer(c.samples, criterion.minSamples) || typeof c.value !== 'number') return false;
      const met = criterion.direction === 'at-least' ? c.value >= criterion.threshold : c.value <= criterion.threshold;
      if (criterion.met !== met) return false;
    } else if (c.value !== null || criterion.met !== null) return false;
    if (b.state === 'verified' && (b.observedAtMs > now || e.baselineOrigin !== expectedOrigin || !integer(b.samples, criterion.minSamples))) return false;
    const delta = b.state === 'verified' && c.state === 'verified' ? (c.value as number) - b.value : null;
    const expectedDelta = delta !== null && Number.isFinite(delta) ? delta : null;
    if (p.delta !== expectedDelta || p.comparisonAvailable !== (expectedDelta !== null)) return false;
    allComparisons &&= expectedDelta !== null;
  }
  return outcomes > 0 && quality > 0 && (e.state === 'verified') === allComparisons;
}

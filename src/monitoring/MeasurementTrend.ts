/** Bounded numeric history on the existing observation/evaluation owner.
 * Identity/version continuity is not inferred from proximity or activity.
 */
import type { MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import type { MaturationMetricObservation, MaturationEvaluationRecord } from './BlockerLifecycleLedger.js';
import { validMaturationOutcomeDetail, type projectMaturationOutcome } from './MaturationOutcome.js';
export interface TrendEvaluation { dueSlotMs: number; evaluatedAtMs: number; contractHash: string; rung: string | null; status: string }
export interface MeasurementPoint { at: number; value: number; samples: number; joinPrevious: boolean; evaluation: TrendEvaluation | null }
export interface MeasurementSeries { source: string; sourceRef: string; descriptorVersion: number; points: MeasurementPoint[] }
export interface MeasurementMetricTrend {
  id: string; source: string; sourceRef: string; direction: 'at-least' | 'at-most'; threshold: number; minSamples: number;
  outcome: boolean; qualityGuard: boolean; historyAvailable: boolean; total: number | null; omitted: number | null; series: MeasurementSeries[];
}
export interface MeasurementTrend {
  schema: 'measurement-detail/1'; advisory: true; authority: 'none'; origin: string; subjectId: string; subjectKnown: boolean;
  generatedAt: string; windowDays: number; currentContractHash: string; cadenceHours: number;
  evidence: ReturnType<typeof projectMaturationOutcome>;
  evaluations: { available: boolean; total: number | null; omitted: number | null; rows: TrendEvaluation[] };
  metrics: MeasurementMetricTrend[];
  historicalContractDetails: 'not-retained';
}

/** Only an exact, unambiguous capture/evaluation join can label a point's
 * contract identity. Backfilled missed slots never serve as that join. */
function evaluationFor(at: number, cadenceHours: number, rows: TrendEvaluation[]): TrendEvaluation | null {
  const slot = Math.floor(at / (cadenceHours * 3_600_000)) * cadenceHours * 3_600_000;
  const matches = rows.filter(r => r.evaluatedAtMs === at && r.dueSlotMs === slot && r.status !== 'missed-cadence');
  return matches.length === 1 ? matches[0] : null;
}

export function measurementTrend(input: {
  origin: string; subjectId: string; subjectKnown: boolean; now: number; windowDays: number;
  contract: MaturationEvaluationContract; contractHash: string; evidence: MeasurementTrend['evidence'];
  evaluations: { total: number; rows: MaturationEvaluationRecord[] } | null;
  observations: Map<string, { total: number; rows: MaturationMetricObservation[]; ambiguousTimes?: number[] } | null>;
}): MeasurementTrend {
  const rows = (input.evaluations?.rows ?? []).map(r => ({ dueSlotMs: r.dueSlotMs, evaluatedAtMs: r.evaluatedAtMs,
    contractHash: r.contractHash, rung: r.rung, status: r.status }));
  const totalEvaluations = input.evaluations?.total ?? null;
  const roles = new Map(input.evidence.metrics.map(m => [m.id, m]));
  const metrics: MeasurementMetricTrend[] = input.contract.metrics.map(m => ({ id: m.id, source: m.source, sourceRef: m.sourceRef,
    direction: m.direction, threshold: m.threshold, minSamples: m.minSamples,
    outcome: roles.get(m.id)?.outcome ?? false,
    qualityGuard: roles.get(m.id)?.qualityGuard ?? false,
    historyAvailable: input.observations.get(m.id) != null, total: input.observations.get(m.id)?.total ?? null,
    omitted: input.observations.get(m.id)?.total ?? null, series: [] }));
  const result: MeasurementTrend = { schema: 'measurement-detail/1', advisory: true, authority: 'none',
    origin: input.origin, subjectId: input.subjectId, subjectKnown: input.subjectKnown, generatedAt: new Date(input.now).toISOString(),
    windowDays: input.windowDays, currentContractHash: input.contractHash, cadenceHours: input.contract.cadenceHours,
    evidence: input.evidence, evaluations: { available: input.evaluations !== null, total: totalEvaluations,
      omitted: totalEvaluations === null ? null : totalEvaluations - rows.length, rows }, metrics, historicalContractDetails: 'not-retained' };
  // Reserve wrapper/counter growth; count all stored rows before trimming the view.
  let bytes = Buffer.byteLength(JSON.stringify(result));
  const ambiguous = metrics.map(metric => {
    const history = input.observations.get(metric.id);
    const times = new Set(history?.ambiguousTimes ?? []); const counts = new Map<number, number>();
    for (const point of history?.rows ?? []) counts.set(point.observedAtMs, (counts.get(point.observedAtMs) ?? 0) + 1);
    for (const [at, count] of counts) if (count > 1) times.add(at);
    return times;
  });
  const groups = metrics.map(() => new Map<string, MeasurementSeries>());
  const stopped = new Set<number>();
  for (let n = 0; n < 96; n++) for (let i = 0; i < metrics.length; i++) {
    if (stopped.has(i)) continue;
    const metric = metrics[i]; const observation = input.observations.get(metric.id)?.rows[n];
    if (!observation) continue;
    const descriptorVersion = observation.descriptorVersion ?? 1;
    const key = JSON.stringify([observation.source, observation.sourceRef, descriptorVersion]);
    const existing = groups[i].get(key);
    const point: MeasurementPoint = { at: observation.observedAtMs, value: observation.value, samples: observation.samples, joinPrevious: false,
      evaluation: ambiguous[i].has(observation.observedAtMs) ? null : evaluationFor(observation.observedAtMs, input.contract.cadenceHours, rows) };
    const group = existing ?? { source: observation.source, sourceRef: observation.sourceRef, descriptorVersion, points: [] };
    const size = Buffer.byteLength(JSON.stringify(point)) + (existing ? 1 : Buffer.byteLength(JSON.stringify(group)) + 1);
    if (bytes + size >= 124 * 1024) { stopped.add(i); continue; }
    if (!existing) { groups[i].set(key, group); metric.series.push(group); }
    group.points.push(point); if (metric.omitted !== null) metric.omitted--; bytes += size;
  }
  for (const metric of metrics) for (const group of metric.series) {
    group.points.sort((a, b) => a.at - b.at);
    for (let i = 1; i < group.points.length; i++) group.points[i].joinPrevious = comparableMeasurementEdge(group.points[i - 1], group.points[i], group, metric, result, (input.observations.get(metric.id)?.rows ?? []).map(p => ({ at: p.observedAtMs })));
  }
  return result;
}

/** Edge rule used by the chart: current known policy only, exact evaluation
 * identity/cadence, compatible source/version and adequate samples. */
export function comparableMeasurementEdge(a: MeasurementPoint, b: MeasurementPoint, series: MeasurementSeries,
  metric: MeasurementMetricTrend, detail: Pick<MeasurementTrend, 'currentContractHash' | 'cadenceHours' | 'generatedAt' | 'evidence'>, allMetricPoints: ReadonlyArray<{ at: number }>): boolean {
  const one = a.evaluation; const two = b.evaluation;
  const expectedVersion = detail.evidence.metrics.find(m => m.id === metric.id)?.descriptorVersion;
  const adjacent = allMetricPoints.filter(p => p.at === a.at).length === 1 && allMetricPoints.filter(p => p.at === b.at).length === 1 && !allMetricPoints.some(p => p.at > a.at && p.at < b.at);
  const cadence = detail.cadenceHours * 3_600_000;
  return Boolean(adjacent && expectedVersion !== undefined && series.descriptorVersion === expectedVersion && one && two && one.contractHash === detail.currentContractHash && two.contractHash === detail.currentContractHash &&
    one.rung === two.rung && two.dueSlotMs - one.dueSlotMs === cadence &&
    one.evaluatedAtMs === a.at && two.evaluatedAtMs === b.at &&
    one.status !== 'missed-cadence' && two.status !== 'missed-cadence' &&
    a.at < b.at && b.at <= Date.parse(detail.generatedAt) &&
    a.samples >= metric.minSamples && b.samples >= metric.minSamples &&
    Number.isSafeInteger(series.descriptorVersion) && series.descriptorVersion > 0 &&
    series.source === metric.source && series.sourceRef === metric.sourceRef);
}

/** Closed peer shape plus cross-field arithmetic; this cannot verify a remote store. */
export function validMeasurementTrend(raw: unknown, origin: string, subjectId: string, now: number): raw is MeasurementTrend {
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
  const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
  const text = (v: unknown, n: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\u0000-\u001f\u007f]/.test(v);
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000_000;
  const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 8_640_000_000_000_000;
  const statuses = ['ready','hold','stale-evidence','insufficient-evidence','missing-contract','invalid-contract','missed-cadence'];
  if (!object(raw) || Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024 ||
      !keys(raw, ['schema','advisory','authority','origin','subjectId','subjectKnown','generatedAt','windowDays','currentContractHash','cadenceHours','evidence','evaluations','metrics','historicalContractDetails']) ||
      raw.schema !== 'measurement-detail/1' || raw.advisory !== true || raw.authority !== 'none' || raw.origin !== origin || raw.subjectId !== subjectId ||
      typeof raw.subjectKnown !== 'boolean' || !text(raw.generatedAt,40) || !Number.isFinite(Date.parse(raw.generatedAt)) ||
      Date.parse(raw.generatedAt) > now + 5000 || now - Date.parse(raw.generatedAt) > 120000 ||
      !count(raw.windowDays) || raw.windowDays < 7 || raw.windowDays > 90 || !text(raw.currentContractHash,64) || !/^[a-f0-9]{64}$/.test(raw.currentContractHash) ||
      !count(raw.cadenceHours) || raw.cadenceHours < 6 || raw.cadenceHours > 168 || raw.cadenceHours % 6 !== 0 || raw.historicalContractDetails !== 'not-retained' ||
      !validMaturationOutcomeDetail({ featureId: subjectId, subjectKnown: raw.subjectKnown, evidence: raw.evidence },origin,now) ||
      !object(raw.evaluations) || !keys(raw.evaluations,['available','total','omitted','rows']) || typeof raw.evaluations.available !== 'boolean' ||
      !Array.isArray(raw.evaluations.rows) || raw.evaluations.rows.length > 128 ||
      (raw.evaluations.available ? (!count(raw.evaluations.total) || !count(raw.evaluations.omitted) || raw.evaluations.total !== raw.evaluations.rows.length + raw.evaluations.omitted) : (raw.evaluations.total !== null || raw.evaluations.omitted !== null || raw.evaluations.rows.length !== 0)) ||
      !Array.isArray(raw.metrics) || raw.metrics.length > 16) return false;
  const validEvaluation = (v: unknown): v is TrendEvaluation => object(v) && keys(v,['dueSlotMs','evaluatedAtMs','contractHash','rung','status']) &&
    time(v.dueSlotMs) && time(v.evaluatedAtMs) && text(v.contractHash,64) && (v.rung === null || text(v.rung,32)) && statuses.includes(String(v.status));
  if (!raw.evaluations.rows.every(validEvaluation)) return false;
  const evaluations = raw.evaluations.rows as TrendEvaluation[];
  const metricIds = new Set<string>();
  for (const item of raw.metrics) {
    if (!object(item) || !keys(item,['id','source','sourceRef','direction','threshold','minSamples','outcome','qualityGuard','historyAvailable','total','omitted','series']) ||
        !text(item.id,63) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.id) || metricIds.has(item.id) ||
        !['blocker-summary','blocker-trend','feature-summary'].includes(String(item.source)) || !text(item.sourceRef,128) ||
        !['at-least','at-most'].includes(String(item.direction)) || typeof item.threshold !== 'number' || !Number.isFinite(item.threshold) ||
        !count(item.minSamples) || item.minSamples < 1 || item.minSamples > 100000 || typeof item.outcome !== 'boolean' || typeof item.qualityGuard !== 'boolean' ||
        typeof item.historyAvailable !== 'boolean' || !Array.isArray(item.series) || item.series.length > 96) return false;
    metricIds.add(item.id); let shown = 0; const seriesKeys = new Set<string>();
    const allMetricPoints = item.series.flatMap(s => object(s) && Array.isArray(s.points) ? s.points.filter(p => object(p) && time(p.at)).map(p => ({ at: p.at as number })) : []);
    for (const series of item.series) {
      if (!object(series) || !keys(series,['source','sourceRef','descriptorVersion','points']) ||
          !['blocker-summary','blocker-trend','feature-summary'].includes(String(series.source)) || !text(series.sourceRef,128) ||
          !count(series.descriptorVersion) || series.descriptorVersion < 1 || !Array.isArray(series.points) || series.points.length < 1 || series.points.length > 96) return false;
      const key = JSON.stringify([series.source,series.sourceRef,series.descriptorVersion]); if (seriesKeys.has(key)) return false; seriesKeys.add(key);
      let previous: MeasurementPoint | null = null;
      for (const point of series.points) {
        if (!object(point) || !keys(point,['at','value','samples','joinPrevious','evaluation']) || !time(point.at) ||
            typeof point.value !== 'number' || !Number.isFinite(point.value) || !count(point.samples) || point.samples > 100000 ||
            typeof point.joinPrevious !== 'boolean' || (previous && point.at <= previous.at)) return false;
        if (point.evaluation !== null) {
          if (!validEvaluation(point.evaluation)) return false;
          const tag = point.evaluation;
          const expected = evaluationFor(point.at,raw.cadenceHours,evaluations);
          if (!expected || tag.evaluatedAtMs !== point.at || tag.contractHash !== expected.contractHash || tag.rung !== expected.rung || tag.dueSlotMs !== expected.dueSlotMs || tag.status !== expected.status) return false;
        }
        if (point.joinPrevious && (!previous || !comparableMeasurementEdge(previous,point as unknown as MeasurementPoint,series as unknown as MeasurementSeries,item as unknown as MeasurementMetricTrend,raw as unknown as MeasurementTrend,allMetricPoints))) return false;
        previous = point as unknown as MeasurementPoint; shown++;
      }
    }
    if (shown > 96 || (item.historyAvailable ? (!count(item.total) || !count(item.omitted) || item.total !== shown + item.omitted) : (item.total !== null || item.omitted !== null || shown !== 0))) return false;
    const proof = (raw.evidence as MeasurementTrend['evidence']).metrics.find(m => m.id === item.id);
    if (proof && (proof.source !== item.source || proof.sourceRef !== item.sourceRef || proof.criterion.direction !== item.direction || proof.criterion.threshold !== item.threshold || proof.criterion.minSamples !== item.minSamples || proof.outcome !== item.outcome || proof.qualityGuard !== item.qualityGuard)) return false;
  }
  const proofMetrics = (raw.evidence as MeasurementTrend['evidence']).metrics;
  if (proofMetrics.length && (proofMetrics.length !== metricIds.size || proofMetrics.some(m => !metricIds.has(m.id)))) return false;
  return true;
}

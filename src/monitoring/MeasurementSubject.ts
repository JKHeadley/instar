/** Exact non-feature target binding. No registry or runtime control owner. */
import crypto from 'node:crypto';
import type { MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import type { EvidenceStrength, GradingRung } from './FeatureMetricsLedger.js';

export type MeasurementTargetState = 'registered' | 'unregistered' | 'unavailable' | 'ambiguous';
export interface MeasurementSubject { kind: 'effort' | 'job' | 'decision' | 'capability'; key: string }
export interface DecisionMeasurementAdapter {
  kind: 'decision-quality'; decisionPoint: string; ruleId: string; rung: GradingRung; evidenceStrength: EvidenceStrength;
  windowHours: number; rightRateMetricId: string; unmatchedShareMetricId: string;
}
export type GenericMeasurementContract = MaturationEvaluationContract & { subject: MeasurementSubject; adapter?: DecisionMeasurementAdapter };
const closed = (v: unknown, fields: string[]): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => fields.includes(k)));
const label = (v: unknown, max = 128): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v) && v.length <= max;
export function hasMeasurementBinding(raw:unknown):boolean {
  return Boolean(raw && typeof raw==='object' && !Array.isArray(raw) && ('subject' in raw || 'adapter' in raw));
}
export function validMeasurementSubject(v: unknown): v is MeasurementSubject {
  return closed(v, ['kind','key']) && ['effort','job','decision','capability'].includes(String(v.kind)) && label(v.key);
}
export function validDecisionMeasurementAdapter(v: unknown, subject: MeasurementSubject, ids: string[]): v is DecisionMeasurementAdapter {
  return closed(v, ['kind','decisionPoint','ruleId','rung','evidenceStrength','windowHours','rightRateMetricId','unmatchedShareMetricId']) &&
    v.kind === 'decision-quality' && label(v.decisionPoint) && label(v.ruleId) &&
    ['deterministic-ground-truth','recurrence','llm-interpreter','self-report'].includes(String(v.rung)) &&
    ['deterministic-proof','negative-evidence','recurrence-proxy','self-report'].includes(String(v.evidenceStrength)) &&
    Number.isSafeInteger(v.windowHours) && (v.windowHours as number) >= 1 && (v.windowHours as number) <= 168 &&
    (subject.kind === 'effort' || subject.kind === 'decision' && subject.key === v.decisionPoint) &&
    typeof v.rightRateMetricId === 'string' && typeof v.unmatchedShareMetricId === 'string' &&
    v.rightRateMetricId !== v.unmatchedShareMetricId && ids.length === 2 && ids.includes(v.rightRateMetricId) && ids.includes(v.unmatchedShareMetricId);
}

/** Reference changes with numeric method/cohort identity, not with a favourable
 * criterion or a declared baseline value. Cannot borrow a feature's projection. */
export function measurementSourceRef(contract: Pick<GenericMeasurementContract, 'subject' | 'adapter' | 'outcome'>, metricId: string): string {
  const identity = [contract.subject.kind, contract.subject.key, contract.outcome?.version, contract.outcome?.method,
    contract.adapter ? [contract.adapter.kind, contract.adapter.decisionPoint, contract.adapter.ruleId, contract.adapter.rung,
      contract.adapter.evidenceStrength, contract.adapter.windowHours, contract.adapter.rightRateMetricId, contract.adapter.unmatchedShareMetricId] : null, metricId];
  return `measurement.${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

/** Shared metadata check used for authoring and immutable archival. */
export function validMeasurementBinding(contract: MaturationEvaluationContract & { subject?: unknown; adapter?: unknown }, initiativeId?: string): boolean {
  if (contract.subject === undefined) return contract.adapter === undefined;
  if (!validMeasurementSubject(contract.subject) || !contract.outcome ||
      (initiativeId !== undefined && contract.subject.kind === 'effort' && contract.subject.key !== initiativeId)) return false;
  const ids = contract.metrics.map(m => m.id);
  if (contract.adapter !== undefined && !validDecisionMeasurementAdapter(contract.adapter, contract.subject, ids)) return false;
  const generic = contract as GenericMeasurementContract;
  if (!contract.metrics.every(m => m.source === 'feature-summary' && m.sourceRef === measurementSourceRef(generic, m.id))) return false;
  if (generic.adapter) {
    const { rightRateMetricId, unmatchedShareMetricId } = generic.adapter;
    const quality = contract.metrics.find(m => m.id === rightRateMetricId)!;
    const guard = contract.metrics.find(m => m.id === unmatchedShareMetricId)!;
    if (!contract.outcome.outcomeMetricIds.includes(rightRateMetricId) || !contract.outcome.qualityMetricIds.includes(unmatchedShareMetricId) ||
        quality.direction !== 'at-least' || guard.direction !== 'at-most' || quality.threshold < 0 || quality.threshold > 1 || guard.threshold < 0 || guard.threshold > 1) return false;
  }
  return true;
}

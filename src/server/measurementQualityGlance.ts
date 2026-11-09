/**
 * Quality history at a glance — one bounded read over the SAME measurement
 * owner the per-item detail uses (readMeasurementDetail). No new state, no
 * verdict authority: every row is the recorded series, the current target from
 * the measurement contract, and the corroborated baseline only when the
 * existing outcome proof says it is verified.
 *
 * Spec: docs/specs/quality-history-glance.md
 */
import type { MeasurementPoint } from '../monitoring/MeasurementTrend.js';
import { measurementOrigin, readMeasurementSubjects, type MeasurementCoverageContext } from './measurementCoverageRead.js';
import { readMeasurementDetail, type MeasurementRead } from './measurementDetailRead.js';

export const QUALITY_GLANCE_SCHEMA = 'measurement-quality-glance/1';
const WINDOW_DAYS = 90;
const MAX_SUBJECTS = 400;
const MAX_ITEMS = 600;
const POINTS_PER_SERIES = 24;
const MAX_BYTES = 1024 * 1024;

/** What the latest recorded point says against the current target. */
export type GlanceStatus = 'off-goal' | 'too-few-samples' | 'at-goal' | 'no-points';

type Proof = NonNullable<MeasurementRead['detail']>['evidence']['metrics'][number];

/** A recorded point as the chart needs it. `current`: its exact evaluation was under the item's
 *  current contract (the same join the detail chart checks); the evaluation itself stays in the detail read. */
export interface GlancePoint { at: number; value: number; samples: number; joinPrevious: boolean; current: boolean }

export interface GlanceItem {
  subjectId: string;
  name: { kind: string; id: string; title: string } | null;
  metric: { id: string; source: string; sourceRef: string; direction: 'at-least' | 'at-most'; threshold: number; minSamples: number;
    outcome: boolean; qualityGuard: boolean; historyAvailable: boolean };
  series: { source: string; sourceRef: string; descriptorVersion: number; points: GlancePoint[] } | null;
  totalPoints: number;
  contractHash: string;
  evidenceState: string;
  proof: Proof | null;
  status: GlanceStatus;
  first: { at: number; value: number; samples: number } | null;
  latest: { at: number; value: number; samples: number } | null;
  /** latest − first point in this window; a recorded difference, never an improvement claim. */
  change: number | null;
  /** Ordering signal only: distance from the target, scaled to the target's size. */
  gap: number;
}

export interface QualityGlance {
  schema: typeof QUALITY_GLANCE_SCHEMA; advisory: true; authority: 'none'; origin: string; generatedAt: string; windowDays: number;
  subjects: number; subjectsOmitted: number; notReadable: Record<string, number>; items: GlanceItem[]; itemsOmitted: number;
  sourcesComplete: boolean; truncatedPoints: boolean;
}

/** Keep real recorded points only: always the first and last, evenly spaced between.
 *  A kept point joins its kept predecessor only when every original step between them was joined. */
export function thinPoints(points: MeasurementPoint[], max = POINTS_PER_SERIES): MeasurementPoint[] {
  if (points.length <= max) return points;
  const keep = new Set<number>();
  for (let i = 0; i < max; i++) keep.add(Math.round(i * (points.length - 1) / (max - 1)));
  const out: MeasurementPoint[] = [];
  let last = -1;
  for (let i = 0; i < points.length; i++) {
    if (!keep.has(i)) continue;
    let joined = last >= 0;
    for (let j = last + 1; j <= i && joined; j++) if (!points[j].joinPrevious) joined = false;
    out.push({ ...points[i], joinPrevious: last >= 0 && joined });
    last = i;
  }
  return out;
}

export function glanceStatus(latest: GlanceItem['latest'], metric: GlanceItem['metric']): GlanceStatus {
  if (!latest) return 'no-points';
  if (latest.samples < metric.minSamples) return 'too-few-samples';
  const met = metric.direction === 'at-least' ? latest.value >= metric.threshold : latest.value <= metric.threshold;
  return met ? 'at-goal' : 'off-goal';
}

const ORDER: Record<GlanceStatus, number> = { 'off-goal': 0, 'too-few-samples': 1, 'at-goal': 2, 'no-points': 3 };
/** Worst first, then the most-changed within each group. */
export function rankGlance(items: GlanceItem[]): GlanceItem[] {
  const moved = (i: GlanceItem) => i.change === null || !i.first ? 0 : Math.abs(i.change) / Math.max(1, Math.abs(i.first.value));
  return [...items].sort((a, b) => ORDER[a.status] - ORDER[b.status]
    || (a.status === 'off-goal' ? b.gap - a.gap : 0)
    || moved(b) - moved(a)
    || a.subjectId.localeCompare(b.subjectId) || a.metric.id.localeCompare(b.metric.id));
}

function slimPoint(p: MeasurementPoint, contractHash: string): GlancePoint {
  return { at: p.at, value: p.value, samples: p.samples, joinPrevious: p.joinPrevious,
    current: p.evaluation?.contractHash === contractHash };
}

/** One measurement read (the per-item detail the board already serves) → its glance rows. */
export function glanceItems(read: MeasurementRead, name: GlanceItem['name'], now: number): { items: GlanceItem[]; truncated: boolean } {
  const items: GlanceItem[] = [];
  let truncated = false;
  const d = read.detail;
  if (read.state !== 'available' || !d) return { items, truncated };
  for (const m of d.metrics) {
    const raw = m.series[0] ?? null;
    const past = (raw?.points ?? []).filter(p => p.at <= now);
    const firstPoint = past[0] ?? null, lastPoint = past[past.length - 1] ?? null;
    const metric = { id: m.id, source: m.source, sourceRef: m.sourceRef, direction: m.direction, threshold: m.threshold, minSamples: m.minSamples,
      outcome: m.outcome, qualityGuard: m.qualityGuard, historyAvailable: m.historyAvailable };
    const latest = lastPoint ? { at: lastPoint.at, value: lastPoint.value, samples: lastPoint.samples } : null;
    const first = firstPoint ? { at: firstPoint.at, value: firstPoint.value, samples: firstPoint.samples } : null;
    if (raw && raw.points.length > POINTS_PER_SERIES) truncated = true;
    const change = first && latest && past.length > 1 && Number.isFinite(latest.value - first.value) ? latest.value - first.value : null;
    const status = glanceStatus(latest, metric);
    const gap = latest && Number.isFinite(latest.value) ? Math.min(1e9, Math.abs(latest.value - m.threshold) / Math.max(1, Math.abs(m.threshold))) : 0;
    items.push({ subjectId: read.subjectId, name, metric,
      series: raw ? { source: raw.source, sourceRef: raw.sourceRef, descriptorVersion: raw.descriptorVersion, points: thinPoints(raw.points).map(p => slimPoint(p, d.currentContractHash)) } : null,
      totalPoints: raw?.points.length ?? 0, contractHash: d.currentContractHash, evidenceState: d.evidence.state,
      proof: d.evidence.metrics.find(p => p.id === m.id) ?? null, status, first, latest, change, gap });
  }
  return { items, truncated };
}

const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

export async function readQualityGlance(ctx: MeasurementCoverageContext, now = Date.now()): Promise<QualityGlance> {
  const census = readMeasurementSubjects(ctx, now);
  const all = [...census.subjects.keys()].sort();
  const subjects = all.slice(0, MAX_SUBJECTS);
  const notReadable: Record<string, number> = {};
  let items: GlanceItem[] = [];
  let truncatedPoints = false;
  for (const subjectId of subjects) {
    await yieldTurn(); // a many-subject read must not hold the event loop
    let read: MeasurementRead;
    try { read = readMeasurementDetail(ctx, subjectId, WINDOW_DAYS, now, { owner: census.subjects.get(subjectId) ?? null, sources: census.sources }); }
    catch { notReadable.unavailable = (notReadable.unavailable ?? 0) + 1; continue; }
    if (read.state !== 'available' || !read.detail) { notReadable[read.state] = (notReadable[read.state] ?? 0) + 1; continue; }
    const names = census.names.get(subjectId) ?? [];
    const built = glanceItems(read, names.find(n => n.kind === 'feature') ?? names[0] ?? null, now);
    if (built.truncated) truncatedPoints = true;
    items.push(...built.items);
  }
  items = rankGlance(items);
  const result: QualityGlance = { schema: QUALITY_GLANCE_SCHEMA, advisory: true, authority: 'none', origin: measurementOrigin(ctx),
    generatedAt: new Date(now).toISOString(), windowDays: WINDOW_DAYS, subjects: subjects.length, subjectsOmitted: all.length - subjects.length,
    notReadable, items: [], itemsOmitted: 0, sourcesComplete: census.sources.every(s => s.ok), truncatedPoints };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (result.items.length >= MAX_ITEMS || bytes + size > MAX_BYTES) { result.itemsOmitted++; continue; }
    result.items.push(item); bytes += size;
  }
  return result;
}
